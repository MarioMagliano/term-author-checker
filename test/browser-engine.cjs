// Runs the PDF engine in a real browser (Chromium, as Web Worker) against a
// local server that behaves like Drive (HTTP Range, bearer token), and checks
// that it gives byte-for-byte the same result as the Apps Script modules run in
// Node (the reference).
//
//   node test/browser-engine.cjs [--pages=120] [--image-kb=400] [--issues=60] [--latency=0] [--flaky] [--out=annotated.pdf]
//
// Needs Playwright (require('playwright')); without it the test is skipped.
// Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');
const base = require('./pdf-memory.cjs');
const builder = require('../tools/build-pdf-worker.cjs');

function arg(name, dflt) {
  const a = process.argv.filter(function(x) { return x.indexOf('--' + name + '=') === 0; })[0];
  return a ? a.slice(name.length + 3) : dflt;
}
function mb(n) { return Math.round(n / 1048576 * 10) / 10; }
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 255; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }

const checks = [];
function check(name, ok, detail) {
  checks.push(ok);
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
}

async function main() {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.log('skipped: Playwright is not installed.'); return; }

  const pageCount = parseInt(arg('pages', '120'), 10);
  const imageKb = parseInt(arg('image-kb', '400'), 10);
  const issueCount = parseInt(arg('issues', '60'), 10);
  const latency = parseInt(arg('latency', '0'), 10);
  const TOKEN = 'test-token';
  const flaky = process.argv.indexOf('--flaky') !== -1;   // every 3rd Drive request fails with HTTP 503
  let flakyCount = 0;

  console.log('building PDF: ' + pageCount + ' pages, ' + imageKb + ' KB image per page ...');
  const built = base.buildPdf(pageCount, 45, imageKb * 1024);
  const pdf = built.pdf;
  const issues = base.buildIssues(issueCount, built.lines).map(function(i) {
    return { type: i.type, original: i.original, suggestion: i.suggestion, explanation: i.explanation, location: i.location };
  });
  console.log('PDF ' + mb(pdf.length) + ' MB');

  // ── Reference: the Apps Script modules in Node ────────────────────────────
  const ctx = base.loadContext();
  const LABELS = { 'type.grammar': 'Grammar' };
  ctx._ct_ = function(key) { return Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : key; };
  const text = pdf.toString('latin1');
  const reader = ctx._pdfStringReader_(text);
  const an = ctx._driveAnnotatedAnalyze_(reader);
  const refRes = ctx._drivePdfComputeAnnotations_(an.doc, an.pages, issues, null, {});
  const refAppendix = ctx._driveAnnotatedAppendix_(reader, an, refRes.pageAnnotations);
  const refHash = fnv(an.model.text);
  const expectedFile = Buffer.concat([pdf, Buffer.from(refAppendix, 'latin1')]);
  const BUDGET = 12 * 1024 * 1024;
  const refParts = (function() {
    const model = ctx.pdfRebuild_(reader, { imageBudget: BUDGET });
    const sp = ctx.pdfPageSplitter_({ text: model.text, offsets: model.offsets, compressed: model.compressed,
                                      rootNum: model.rootNum, maxNum: model.maxNum, encrypted: model.encrypted });
    const n = sp.pageCount, count = Math.min(Math.ceil(n / 4), 60), per = Math.ceil(n / Math.max(1, count));
    const ranges = [], pieces = [];
    for (let f = 0; f < n; f += per) { ranges.push([f, Math.min(n, f + per)]); pieces.push(sp.build(f, Math.min(n, f + per))); }
    return { n: n, per: per, ranges: ranges, sizes: pieces.map(function(x) { return x.length; }),
             first: pieces[0], last: pieces[pieces.length - 1], imagesKept: model.imagesKept,
             // for the whole-document prompts: the whole rebuilt PDF and the text of all pages (as the add-on reads them)
             wholeLen: model.text.length, wholeHash: fnv(model.text), texts: ctx._pdfExtractPageTexts_(model.text) };
  })();

  // ── Server that behaves like Drive ───────────────────────────────────────
  const stats = { requests: 0, bytes: 0, badAuth: 0, inflight: 0, maxInflight: 0 };
  let uploaded = null;
  const client = fs.readFileSync(path.join(__dirname, '..', 'PdfBrowserClient.html'), 'utf8');
  const html = '<!doctype html><meta charset="utf-8"><body>' + builder.build() + client + '</body>';
  const server = http.createServer(function(req, res) {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.url === '/pdf') {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { stats.badAuth++; res.writeHead(401); res.end(); return; }
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (flaky && ++flakyCount % 3 === 0) { res.writeHead(503); res.end(); return; }
      stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      setTimeout(function() {
        stats.inflight--;
        stats.requests++;
        if (!m) { res.writeHead(200, { 'Content-Length': pdf.length }); res.end(pdf); stats.bytes += pdf.length; return; }
        const s = parseInt(m[1], 10), e = Math.min(pdf.length - 1, parseInt(m[2], 10));
        stats.bytes += e - s + 1;
        res.writeHead(206, { 'Content-Range': 'bytes ' + s + '-' + e + '/' + pdf.length, 'Content-Length': e - s + 1, 'Content-Type': 'application/pdf' });
        res.end(pdf.subarray(s, e + 1));
      }, latency);
      return;
    }
    if (req.url === '/upload' && req.method === 'POST') {
      const bufs = [];
      req.on('data', function(c) { bufs.push(c); });
      req.on('end', function() { uploaded = Buffer.concat(bufs); res.writeHead(200); res.end('ok'); });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(function(r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;

  // Peak memory of the browser processes (RSS), sampled while it works.
  let peakRss = 0, baseRss = 0;
  function rssKb() {
    try {
      return execSync("ps -eo rss,comm | grep -i -E 'chrom|headless' | awk '{s+=$1} END {print s+0}'", { encoding: 'utf8' }).trim() * 1;
    } catch (e) { return 0; }
  }
  const sampler = setInterval(function() { const r = rssKb(); if (r > peakRss) peakRss = r; }, 250);

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', function(e) { errors.push(e.message); });
    page.on('console', function(m) {
      // With --flaky the browser itself logs every 503 it gets - expected.
      if (m.type() === 'error' && !(flaky && /status of 503/.test(m.text()))) errors.push(m.text());
    });
    await page.goto('http://127.0.0.1:' + port + '/');
    baseRss = rssKb();

    const P = { base: 'http://127.0.0.1:' + port, token: TOKEN, size: pdf.length, issues: issues, labels: LABELS };
    const phasePeak = {};
    async function phase(name, fn, arg) {
      peakRss = 0;
      const r = await page.evaluate(fn, arg);
      phasePeak[name] = Math.max(0, peakRss - baseRss) * 1024;
      return r;
    }
    const out = {};
    out.open = await phase('open', async function(p) {
      window.__pdf = PdfBrowser.create();
      const t0 = performance.now();
      const open = await window.__pdf.open({ url: p.base + '/pdf', token: p.token, size: p.size });
      open.ms2 = Math.round(performance.now() - t0);
      return open;
    }, P);
    const ann = await phase('annotate', async function(p) {
      const progress = [];
      const t0 = performance.now();
      const ann = await window.__pdf.annotate(p.issues, p.labels, function(x) { progress.push(x.next); });
      let b = ''; const u = ann.appendix;
      for (let i = 0; i < u.length; i += 8192) b += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      window.__appendix = u;
      return { count: ann.count, total: ann.total, positioned: ann.positioned, slices: ann.slices, appendixBytes: ann.appendixBytes,
               appendix: b, progressCalls: progress.length, ms: Math.round(performance.now() - t0) };
    }, P);
    out.ann = ann; out.appendix = ann.appendix; out.progressCalls = ann.progressCalls;
    const blobInfo = await phase('result file', async function(p) {
      const t0 = performance.now();
      const blob = await window.__pdf.annotatedBlob(window.__appendix);
      const ms = Math.round(performance.now() - t0);
      const up = await fetch(p.base + '/upload', { method: 'POST', body: blob });
      return { size: blob.size, upload: up.status, ms: ms };
    }, P);
    out.blobSize = blobInfo.size; out.upload = blobInfo.upload;
    const splitInfo = await phase('check parts', async function(p) {
      const t0 = performance.now();
      const c2 = PdfBrowser.create();
      const open = await c2.open({ url: p.base + '/pdf', token: p.token, size: p.size, imageBudget: p.budget });
      const plan = await c2.plan({ pagesPerPart: 4, maxParts: 60 });
      const sizes = []; let first = '', last = '';
      for (let i = 0; i < plan.ranges.length; i++) {
        const piece = await c2.piece(plan.ranges[i][0], plan.ranges[i][1]);
        sizes.push(piece.bytes);
        if (i === 0) first = piece.b64;
        if (i === plan.ranges.length - 1) last = piece.b64;
      }
      const single = await c2.piece(0, 1);
      const whole = await c2.whole();
      const bin = atob(whole.b64);
      let h = 0x811c9dc5;
      for (let i = 0; i < bin.length; i++) { h ^= bin.charCodeAt(i) & 255; h = Math.imul(h, 0x01000193) >>> 0; }
      const pt = await c2.pageTexts();
      c2.close();
      return { open: { imagesKept: open.imagesKept, shrunkBytes: open.shrunkBytes }, plan: plan, sizes: sizes, first: first, last: last, singleBytes: single.bytes,
               wholeBytes: whole.bytes, wholeHash: h >>> 0, texts: pt.texts, ms: Math.round(performance.now() - t0) };
    }, Object.assign({ budget: BUDGET }, P));
    out.split = splitInfo;
    await page.evaluate(function() { window.__pdf.close(); });
    out.ms = { open: out.open.ms2, annotate: ann.ms, blob: blobInfo.ms, split: splitInfo.ms };

    // ── Checks ─────────────────────────────────────────────────────────────
    check('no page errors', errors.length === 0, errors.join(' | '));
    check('same page count as reference', out.open.pages === an.pages.length, out.open.pages + ' pages');
    check('rebuilt (image-free) PDF identical to reference', out.open.shrunkHash === refHash && out.open.shrunkBytes === an.model.text.length,
      mb(out.open.shrunkBytes) + ' MB from ' + mb(pdf.length) + ' MB');
    check('all images removed in annotate mode', out.open.imagesRemoved === pageCount && out.open.imagesKept === 0);
    // Images are the bulk of the file; they must only be peeked at, not downloaded.
    // (Objects below 128 KB are read as a whole by design, so this only holds for big images.)
    check('images are not downloaded', imageKb * 1024 <= 128 * 1024 || out.open.downloadedBytes < pdf.length * 0.25,
      mb(out.open.downloadedBytes) + ' MB read of ' + mb(pdf.length) + ' MB in ' + out.open.requests + ' requests');
    check('annotation count and positions identical', out.ann.count === refRes.count && out.ann.positioned === refRes.positioned,
      out.ann.positioned + ' positioned of ' + out.ann.count);
    let appDetail = Math.round(out.ann.appendixBytes / 1024) + ' KB';
    if (out.appendix !== refAppendix) {
      let d = 0; while (d < out.appendix.length && out.appendix[d] === refAppendix[d]) d++;
      appDetail = 'first difference at ' + d + ' of ' + refAppendix.length + ': ref ' + JSON.stringify(refAppendix.slice(Math.max(0, d - 40), d + 60)) +
        ' browser ' + JSON.stringify(out.appendix.slice(Math.max(0, d - 40), d + 60));
    }
    check('appendix identical to reference (byte for byte)', out.appendix === refAppendix, appDetail);
    check('search ran in slices with progress', out.ann.slices >= 1 && out.progressCalls === out.ann.slices - 1, out.ann.slices + ' slices');
    check('annotated file = original + appendix', out.blobSize === expectedFile.length && uploaded && uploaded.equals(expectedFile),
      mb(out.blobSize) + ' MB');
    check('original bytes unchanged at the start of the result', uploaded && uploaded.subarray(0, pdf.length).equals(pdf));
    check('every request carried the token', stats.badAuth === 0);
    if (flaky) check('failed requests were repeated', out.open.retries > 0, out.open.retries + ' retries');
    check('check preparation: same parts as reference', JSON.stringify(out.split.plan.ranges) === JSON.stringify(refParts.ranges) &&
      JSON.stringify(out.split.sizes) === JSON.stringify(refParts.sizes), out.split.plan.ranges.length + ' parts, ' + out.split.open.imagesKept + ' images kept');
    check('check preparation: first and last part identical to reference',
      Buffer.from(out.split.first, 'base64').toString('latin1') === refParts.first && Buffer.from(out.split.last, 'base64').toString('latin1') === refParts.last);
    check('whole-document prompts: the whole rebuilt PDF is identical to the add-on\'s',
      out.split.wholeBytes === refParts.wholeLen && out.split.wholeHash === refParts.wholeHash && out.split.open.shrunkBytes === refParts.wholeLen, mb(refParts.wholeLen) + ' MB');
    check('whole-document prompts: the page text is identical to the add-on\'s (' + refParts.texts.length + ' pages)',
      JSON.stringify(out.split.texts) === JSON.stringify(refParts.texts) && out.split.texts.length === pageCount && out.split.texts[0].indexOf('mark1x0') !== -1);
    check('a single page can be built as its own PDF', out.split.singleBytes > 0 && out.split.singleBytes < refParts.sizes[0]);

    // The output must open in a real PDF reader and carry the notes.
    const outFile = arg('out', path.join(require('os').tmpdir(), 'browser-engine-annotated.pdf'));
    fs.writeFileSync(outFile, uploaded || Buffer.alloc(0));
    let pyOk = false, pyDetail = '';
    try {
      const py = "import sys,pypdf\nr=pypdf.PdfReader(sys.argv[1])\nn=sum(len(p.get('/Annots') or []) for p in r.pages)\nprint(len(r.pages), n)";
      const o = execFileSync('python3', ['-c', py, outFile], { encoding: 'utf8' }).trim().split(' ').map(Number);
      pyOk = o[0] === pageCount && o[1] >= refRes.count; pyDetail = o[0] + ' pages, ' + o[1] + ' annotations';
    } catch (e) { pyDetail = String(e.message).split('\n')[0]; }
    check('pypdf opens the result: pages and notes present', pyOk, pyDetail);

    // ── The page (PdfBrowser.html) end to end: Drive, Apps Script and Gemini simulated ──
    const FILE_ID = 'F'.repeat(33);
    const pageHtml = fs.readFileSync(path.join(__dirname, '..', 'PdfBrowser.html'), 'utf8')
      .replace('<?= fileId ?>', '')
      .replace('<?!= JSON.stringify(languages) ?>', function() { return JSON.stringify([['de', 'German'], ['en', 'English']]); })
      .replace('<?!= JSON.stringify(lastLang) ?>', function() { return JSON.stringify('de'); })
      .replace('<?!= JSON.stringify(parallel) ?>', function() { return '6'; })
      .replace("<?!= include('PdfWorkerSource'); ?>", function() { return builder.build(); })
      .replace("<?!= include('PdfBrowserClient'); ?>", function() { return client; });
    const ctx2 = await browser.newContext({ acceptDownloads: true });
    await ctx2.route('**/*', function(route) {
      const url = route.request().url();
      if (url === 'https://app.test/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml });
      if (url.indexOf('https://www.googleapis.com/drive/v3/files/' + FILE_ID) === 0) {
        const h = route.request().headers();
        if (h.authorization !== 'Bearer ' + TOKEN) return route.fulfill({ status: 401, body: '' });
        const m = /bytes=(\d+)-(\d+)/.exec(h.range || '');
        const s0 = parseInt(m[1], 10), e0 = Math.min(pdf.length - 1, parseInt(m[2], 10));
        return route.fulfill({ status: 206, headers: { 'Content-Range': 'bytes ' + s0 + '-' + e0 + '/' + pdf.length }, body: pdf.subarray(s0, e0 + 1) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const ui = await ctx2.newPage();
    const uiErrors = [];
    ui.on('pageerror', function(e) { uiErrors.push(e.message); });

    // Simulated Apps Script + Gemini. Gemini "finds" one issue per checked part: a real line
    // of the first page of the part. The second part always fails when it has several pages,
    // so the page has to check it page by page.
    const srvLog = { prepare: 0, parts: [], failedParts: 0, logged: null, sheetIssues: 0, languages: [], doc: [], docReport: null };
    const quoteOf = function(pageIdx, line) { return built.lines[pageIdx][line === undefined ? 3 : line].split(' ').slice(2, 8).join(' '); };
    // Whole-document prompts ("Gems"): A works, B is rejected with the PDF but works with the page text, C always fails.
    const GEMS = ['Gem A', 'Gem B', 'Gem C'];
    const gemIssue = function(title, page, line, n) {
      return { type: 'prompt', rule: title, location: 'Page ' + (page + 1), original: quoteOf(page, line), suggestion: 'gem fix ' + n, explanation: 'simulated', replaceable: false };
    };
    await ui.exposeFunction('__srv', function(name, args) {
      if (name === 'apiPdfBrowserPrepare') {
        srvLog.prepare++; srvLog.languages.push(args[1]);
        return { fileId: FILE_ID, name: 'Handbuch <b>1</b>.pdf', size: pdf.length, token: TOKEN, labels: { 'type.grammar': 'Grammar' },
                 language: args[1], languageName: 'German', docPromptTitles: GEMS, docMaxBytes: 50 * 1024 * 1024, maxBytes: 15 * 1024 * 1024 };
      }
      if (name === 'apiPdfBrowserCheckPart') {
        const b64 = args[0], meta = args[1];
        const head = Buffer.from(b64.slice(0, 16), 'base64').toString('latin1').slice(0, 5);
        srvLog.parts.push({ from: meta.from, to: meta.to, split: meta.split, pdf: head === '%PDF-', imagesRemoved: meta.imagesRemoved });
        if (meta.from === refParts.per && meta.to - meta.from > 1) { srvLog.failedParts++; return { failed: true, error: 'simulated' }; }
        return { issues: [{ type: (meta.from % 2) ? 'spelling' : 'grammar', location: 'Page ' + (meta.from + 1), original: quoteOf(meta.from), suggestion: 'fixed ' + meta.from, explanation: 'simulated' }] };
      }
      if (name === 'apiPdfBrowserDocPrompts') {
        const req = args[0];
        srvLog.doc.push({ mode: req.mode, indexes: req.indexes, pdf: !!req.b64 && Buffer.from(req.b64.slice(0, 16), 'base64').toString('latin1').slice(0, 5) === '%PDF-',
                          texts: req.texts ? req.texts.length : 0, firstPageHasMarker: !!(req.texts && req.texts[0].indexOf('mark1x0') !== -1), pages: req.pages, sizeBytes: req.sizeBytes });
        const reports = req.indexes.map(function(i) {
          if (i === 2) return { title: GEMS[2], error: 'AI request failed (503).', code: 503 };
          if (i === 1 && req.mode === 'pdf') return { title: GEMS[1], error: 'AI request failed (400).', code: 400 };
          const issues = i === 0 ? [gemIssue(GEMS[0], 1, 5, 1), gemIssue(GEMS[0], 3, 5, 2)] : [gemIssue(GEMS[1], 2, 6, 3)];
          return { title: GEMS[i], markdown: '# Report ' + i, issues: issues, note: req.mode === 'text' ? 'text mode' : '' };
        });
        return { indexes: req.indexes, reports: reports };
      }
      if (name === 'apiPdfBrowserDocReport') { srvLog.docReport = { file: args[0], titles: args[1].map(function(r) { return r.title; }), noIssues: args[1].every(function(r) { return !('issues' in r); }) }; return { url: 'https://doc.test/report', items: [] }; }
      if (name === 'apiPdfBrowserLogRun') { srvLog.logged = args; return true; }
      if (name === 'apiPdfBrowserExportSheet') { srvLog.sheetIssues = args[0].length; return 'https://sheet.test/report'; }
      throw new Error('unexpected call ' + name);
    });
    await ui.addInitScript(function() {
      window.PDF_BROWSER_RETRY_MS = 5;
      // google.script.run.withSuccessHandler(f).withFailureHandler(g).apiXyz(args...)
      window.google = { script: { run: { withSuccessHandler: function(ok) { return { withFailureHandler: function(bad) {
        return new Proxy({}, { get: function(t, name) { return function() {
          const args = Array.prototype.slice.call(arguments);
          window.__srv(name, args).then(ok, function(e) { bad(new Error(String(e && e.message || e))); });
        }; } });
      } }; } } } };
    });
    await ui.goto('https://app.test/');
    check('page: language list filled', (await ui.$$eval('#lang option', function(o) { return o.length; })) === 2);
    await ui.fill('#file', 'https://drive.google.com/file/d/' + FILE_ID + '/view');
    await ui.selectOption('#lang', 'de');
    await ui.click('#checkBtn');
    await ui.waitForSelector('#resBox', { state: 'visible', timeout: 180000 });
    const rows = await ui.$$eval('#steps tr', function(r) { return r.map(function(x) { return x.textContent; }); });
    const notes = await ui.$eval('#notes', function(n) { return n.textContent; });
    const chips = await ui.$eval('#chips', function(n) { return n.textContent; });
    const issueRows = await ui.$$eval('#issues tr', function(r) { return r.length - 1; });
    const nParts = refParts.ranges.length;
    const pageIssues = (nParts - 1) + refParts.per;   // every part, except the failing one that is checked page by page
    const expectedIssues = pageIssues + 3;             // plus the findings of Gem A (2) and Gem B (1)
    check('page: all steps ok, no errors', rows.length >= 6 && rows.every(function(t) { return t.indexOf('✖') === -1; }) && uiErrors.length === 0, uiErrors.join(' | '));
    check('page: file name is shown as text, not as HTML', rows.join(' ').indexOf('<b>1</b>') !== -1 && (await ui.$$('#steps b')).length === 0);
    check('page: whole-document prompts first go with the PDF, the rejected one is repeated with the page text',
      srvLog.doc.length === 2 && srvLog.doc[0].mode === 'pdf' && JSON.stringify(srvLog.doc[0].indexes) === '[0,1,2]' && srvLog.doc[0].pdf &&
      srvLog.doc[1].mode === 'text' && JSON.stringify(srvLog.doc[1].indexes) === '[1,2]', JSON.stringify(srvLog.doc.map(function(d) { return d.mode + ':' + d.indexes; })));
    check('page: page text of the whole document reaches the server', srvLog.doc[1].texts === pageCount && srvLog.doc[1].firstPageHasMarker && srvLog.doc[1].pages === pageCount && srvLog.doc[1].sizeBytes > 0);
    check('page: the report of the prompts is created and linked', srvLog.docReport && JSON.stringify(srvLog.docReport.titles) === JSON.stringify([GEMS[0], GEMS[1]]) &&
      srvLog.docReport.noIssues && (await ui.$eval('#docReportLink', function(a) { return a.href; })) === 'https://doc.test/report', JSON.stringify(srvLog.docReport));
    check('page: only real problems are shown as messages (no hints about disabled or unsupported prompts)',
      notes.indexOf('Gem C') !== -1 && notes.indexOf('fehlgeschlagen') !== -1 && notes.indexOf('Gem A') === -1 && notes.indexOf('Gem B') === -1 &&
      notes.indexOf('laufen im Browser-Weg') === -1 && notes.indexOf('ausgeschaltet') === -1, notes);
    check('page: every part sent to the check as its own PDF', srvLog.parts.length > 0 && srvLog.parts.every(function(x) { return x.pdf; }) &&
      srvLog.parts.filter(function(x) { return x.to - x.from === refParts.per || x.to === refParts.n; }).length >= nParts, srvLog.parts.length + ' calls for ' + nParts + ' parts');
    check('page: parts of several pages are marked as split', srvLog.parts.every(function(x) { return x.split === true; }));
    check('page: failing part was retried and then checked page by page', srvLog.failedParts === 3 &&
      srvLog.parts.filter(function(x) { return x.to - x.from === 1 && x.from >= refParts.per && x.from < 2 * refParts.per; }).length === refParts.per, srvLog.failedParts + ' failed calls');
    check('page: issues of all parts and of the prompts collected', issueRows === expectedIssues && chips.indexOf(expectedIssues + ' Funde') !== -1, issueRows + ' of ' + expectedIssues);
    check('page: every prompt with findings is its own category, like Terminologie or Grammatik',
      chips.indexOf('Gem A') !== -1 && chips.indexOf('Gem B') !== -1 && chips.indexOf('Gem C') === -1 && (await ui.$$('#chips [data-cat^="p:"]')).length === 2);
    check('page: chips count the real types (spelling is not hidden under style)', chips.indexOf('Rechtschreibung') !== -1 && chips.indexOf('Grammatik') !== -1 && chips.indexOf('Stil') === -1, chips);
    check('page: buttons show how many findings they use', (await ui.$eval('#annBtn', function(b) { return b.textContent; })) === 'Kommentierte PDF erzeugen (' + expectedIssues + ')');
    check('page: run is logged', srvLog.logged && srvLog.logged[0] === 'Handbuch <b>1</b>.pdf' && srvLog.logged[1] === expectedIssues && srvLog.logged[2] === nParts);

    await ui.click('#sheetBtn');
    await ui.waitForSelector('#sheetLink', { timeout: 30000 });
    check('page: sheet export gets the issues and shows a link', srvLog.sheetIssues === expectedIssues && (await ui.$eval('#sheetLink', function(a) { return a.href; })) === 'https://sheet.test/report');

    await ui.click('#annBtn');
    await ui.waitForSelector('#dlLink', { timeout: 180000 });
    const dlPromise = ui.waitForEvent('download', { timeout: 120000 });
    await ui.click('#dlLink');
    const dl = await dlPromise;
    const dlPath = path.join(require('os').tmpdir(), 'browser-page-download.pdf');
    await dl.saveAs(dlPath);
    const dlBuf = fs.readFileSync(dlPath);
    check('page: download = original + appendix', dlBuf.subarray(0, pdf.length).equals(pdf) && dlBuf.length > pdf.length,
      mb(dlBuf.length) + ' MB, download name ' + dl.suggestedFilename());
    let uiPy = '';
    try {
      const py = "import sys,pypdf\nr=pypdf.PdfReader(sys.argv[1])\nn=sum(len(p.get('/Annots') or []) for p in r.pages)\nprint(len(r.pages), n)";
      uiPy = execFileSync('python3', ['-c', py, dlPath], { encoding: 'utf8' }).trim();
    } catch (e) { uiPy = String(e.message).split('\n')[0]; }
    // Every issue quotes a real line, so each gets a note and a highlight.
    check('page: every issue is a note and a highlight in the downloaded PDF', uiPy === pageCount + ' ' + (2 * expectedIssues), uiPy);

    // Filter: a category can be switched off; list, buttons and both exports follow.
    const catCount = async function(c) { return ui.$eval('#chips [data-cat="' + c + '"] b', function(b) { return parseInt(b.textContent, 10); }); };
    const spelling = await catCount('spelling');
    await ui.click('#chips [data-cat="p:Gem A"]');
    check('page: switching a category off hides its findings and shows it as off',
      (await ui.$$eval('#issues tr', function(r) { return r.length - 1; })) === expectedIssues - 2 &&
      (await ui.$eval('#chips [data-cat="p:Gem A"]', function(c) { return c.classList.contains('off') && c.getAttribute('aria-pressed') === 'false'; })) &&
      (await ui.$eval('#chips', function(n) { return n.textContent; })).indexOf((expectedIssues - 2) + ' von ' + expectedIssues + ' Funde') !== -1);
    await ui.click('#chips [data-cat="spelling"]');
    const filteredCount = expectedIssues - 2 - spelling;
    check('page: several categories can be off at once; the buttons show the new count',
      (await ui.$$eval('#issues tr', function(r) { return r.length - 1; })) === filteredCount &&
      (await ui.$eval('#sheetBtn', function(b) { return b.textContent; })) === 'Als Sheet exportieren (' + filteredCount + ')' &&
      (await ui.$eval('#annBtn', function(b) { return b.textContent; })) === 'Kommentierte PDF erzeugen (' + filteredCount + ')', 'expected ' + filteredCount);
    await ui.click('#sheetBtn');
    await ui.waitForFunction(function() { return document.getElementById('sheetLink'); }, null, { timeout: 30000 });
    check('page: the sheet export only gets the findings that are switched on', srvLog.sheetIssues === filteredCount, srvLog.sheetIssues + ' of ' + filteredCount);
    await ui.click('#annBtn');
    await ui.waitForSelector('#dlLink', { timeout: 180000 });
    const dl2Promise = ui.waitForEvent('download', { timeout: 120000 });
    await ui.click('#dlLink');
    const dl2 = await dl2Promise;
    const dl2Path = path.join(require('os').tmpdir(), 'browser-page-download-filtered.pdf');
    await dl2.saveAs(dl2Path);
    let uiPy2 = '';
    try { uiPy2 = execFileSync('python3', ['-c', "import sys,pypdf\nr=pypdf.PdfReader(sys.argv[1])\nprint(len(r.pages), sum(len(p.get('/Annots') or []) for p in r.pages))", dl2Path], { encoding: 'utf8' }).trim(); }
    catch (e) { uiPy2 = String(e.message).split('\n')[0]; }
    check('page: the commented PDF only contains the findings that are switched on', uiPy2 === pageCount + ' ' + (2 * filteredCount), uiPy2);
    await ui.click('#chipAll');
    check('page: "alle anzeigen" switches everything on again',
      (await ui.$$eval('#issues tr', function(r) { return r.length - 1; })) === expectedIssues && (await ui.$$('#chipAll')).length === 0 &&
      (await ui.$eval('#sheetBtn', function(b) { return b.textContent; })) === 'Als Sheet exportieren (' + expectedIssues + ')');

    // Diagnostic probe on the same opened file.
    await ui.click('#diagBox summary');
    await ui.fill('#quote', quoteOf(0));
    await ui.fill('#pageNo', '1');
    await ui.click('#probeBtn');
    await ui.waitForSelector('#probeLink', { timeout: 180000 });
    check('page: probe comment works on the opened file', (await ui.$eval('#probeMsg', function(n) { return n.textContent; })).indexOf('1 von 1') !== -1);
    await ctx2.close();

    console.log('\nopen      ' + out.ms.open + ' ms, ' + out.open.requests + ' requests, downloaded ' + mb(out.open.downloadedBytes) + ' MB, retries ' + out.open.retries);
    console.log('annotate  ' + out.ms.annotate + ' ms, ' + out.ann.slices + ' slices');
    console.log('result    ' + out.ms.blob + ' ms (original + appendix as file)');
    console.log('parts     ' + out.ms.split + ' ms (check preparation, ' + out.split.plan.ranges.length + ' parts)');
    console.log('server    ' + stats.requests + ' requests, ' + mb(stats.bytes) + ' MB served, latency ' + latency + ' ms per request, at most ' + stats.maxInflight + ' at the same time');
    console.log('browser   peak memory over start (all Chromium processes):');
    Object.keys(phasePeak).forEach(function(k) { console.log('          ' + (k + '          ').slice(0, 14) + '+' + mb(phasePeak[k]) + ' MB'); });
  } finally {
    clearInterval(sampler);
    await browser.close();
    server.close();
  }

  const ok = checks.every(Boolean);
  console.log(ok ? 'OK' : 'FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch(function(e) { console.error(e); process.exit(1); });

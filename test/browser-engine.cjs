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
  const refSplit = (function() {
    const model = ctx.pdfRebuild_(reader, { imageBudget: 12 * 1024 * 1024 });
    const sp = ctx.pdfPageSplitter_({ text: model.text, offsets: model.offsets, compressed: model.compressed,
                                      rootNum: model.rootNum, maxNum: model.maxNum, encrypted: model.encrypted });
    const sizes = [];
    for (let f = 0; f < sp.pageCount; f += 4) sizes.push(sp.build(f, Math.min(sp.pageCount, f + 4)).length);
    return sizes;
  })();

  // ── Server that behaves like Drive ───────────────────────────────────────
  const stats = { requests: 0, bytes: 0, badAuth: 0 };
  let uploaded = null;
  const client = fs.readFileSync(path.join(__dirname, '..', 'PdfBrowserClient.html'), 'utf8');
  const html = '<!doctype html><meta charset="utf-8"><body>' + builder.build() + client + '</body>';
  const server = http.createServer(function(req, res) {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.url === '/pdf') {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { stats.badAuth++; res.writeHead(401); res.end(); return; }
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (flaky && ++flakyCount % 3 === 0) { res.writeHead(503); res.end(); return; }
      setTimeout(function() {
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
      const split = await window.__pdf.split({ pagesPerPart: 4 });
      const part0 = await window.__pdf.part(0);
      return { split: split, part0: Array.from(part0.subarray(0, 8)), part0Len: part0.length, ms: Math.round(performance.now() - t0) };
    }, P);
    out.split = splitInfo.split; out.part0 = splitInfo.part0; out.part0Len = splitInfo.part0Len;
    await page.evaluate(function() { window.__pdf.close(); });
    out.ms = { open: out.open.ms2, annotate: ann.ms, blob: blobInfo.ms, split: splitInfo.ms };

    // ── Checks ─────────────────────────────────────────────────────────────
    check('no page errors', errors.length === 0, errors.join(' | '));
    check('same page count as reference', out.open.pages === an.pages.length, out.open.pages + ' pages');
    check('rebuilt (image-free) PDF identical to reference', out.open.shrunkHash === refHash && out.open.shrunkBytes === an.model.text.length,
      mb(out.open.shrunkBytes) + ' MB from ' + mb(pdf.length) + ' MB');
    check('all images removed in annotate mode', out.open.imagesRemoved === pageCount && out.open.imagesKept === 0);
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
    check('check preparation: same part sizes as reference', JSON.stringify(out.split.sizes) === JSON.stringify(refSplit),
      out.split.parts + ' parts, ' + out.split.imagesKept + ' images kept');
    check('part is a PDF', String.fromCharCode.apply(null, out.part0.slice(0, 5)) === '%PDF-' && out.part0Len === refSplit[0]);

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

    // ── The test page (PdfBrowser.html) end to end, Drive and Apps Script simulated ──
    const FILE_ID = 'F'.repeat(33);
    const pageHtml = fs.readFileSync(path.join(__dirname, '..', 'PdfBrowser.html'), 'utf8')
      .replace('<?= fileId ?>', FILE_ID)
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
    await ui.addInitScript(function(args) {
      // google.script.run.withSuccessHandler(f).withFailureHandler(g).apiXyz(arg)
      window.google = { script: { run: { withSuccessHandler: function(ok) { return { withFailureHandler: function(bad) {
        return new Proxy({}, { get: function(t, name) { return function() {
          setTimeout(function() {
            if (name === 'apiPdfBrowserInit') ok({ fileId: args.id, name: 'Handbuch <b>1</b>.pdf', size: args.size, token: args.token, labels: {} });
            else bad(new Error('unexpected call ' + String(name)));
          }, 10);
        }; } });
      } }; } } } };
    }, { id: FILE_ID, size: pdf.length, token: TOKEN });
    await ui.goto('https://app.test/');   // fileId is prefilled: the page starts reading right away
    await ui.waitForSelector('#annBox', { state: 'visible', timeout: 120000 });
    const rows = await ui.$$eval('#steps tr', function(r) { return r.map(function(x) { return x.textContent; }); });
    const firstWords = built.lines[0][3].split(' ').slice(2, 8).join(' ');
    await ui.fill('#quote', firstWords);
    await ui.fill('#pageNo', '1');
    await ui.click('#annBtn');
    await ui.waitForSelector('#dlLink', { timeout: 120000 });
    const dlPromise = ui.waitForEvent('download', { timeout: 120000 });
    await ui.click('#dlLink');
    const dl = await dlPromise;
    const dlPath = path.join(require('os').tmpdir(), 'browser-page-download.pdf');
    await dl.saveAs(dlPath);
    const dlBuf = fs.readFileSync(dlPath);
    check('test page: all steps ok, no errors', rows.length >= 4 && rows.every(function(t) { return t.indexOf('✖') === -1; }) && uiErrors.length === 0, uiErrors.join(' | '));
    check('test page: file name is shown as text, not as HTML', rows.join(' ').indexOf('<b>1</b>') !== -1 && (await ui.$$('#steps b')).length === 0);
    check('test page: download = original + appendix', dlBuf.subarray(0, pdf.length).equals(pdf) && dlBuf.length > pdf.length,
      mb(dlBuf.length) + ' MB, download name ' + dl.suggestedFilename());
    let uiPy = '';
    try {
      const py = "import sys,pypdf\nr=pypdf.PdfReader(sys.argv[1])\na=r.pages[0].get('/Annots') or []\nprint(len(r.pages), len(a), any('Browser' in str(x.get_object().get('/Contents','')) for x in a))";
      uiPy = execFileSync('python3', ['-c', py, dlPath], { encoding: 'utf8' }).trim();
    } catch (e) { uiPy = String(e.message).split('\n')[0]; }
    check('test page: note with the entered text is on page 1', uiPy === pageCount + ' 2 True', uiPy);
    await ctx2.close();

    console.log('\nopen      ' + out.ms.open + ' ms, ' + out.open.requests + ' requests, downloaded ' + mb(out.open.downloadedBytes) + ' MB, retries ' + out.open.retries);
    console.log('annotate  ' + out.ms.annotate + ' ms, ' + out.ann.slices + ' slices');
    console.log('result    ' + out.ms.blob + ' ms (original + appendix as file)');
    console.log('parts     ' + out.ms.split + ' ms (check preparation, ' + out.split.parts + ' parts)');
    console.log('server    ' + stats.requests + ' requests, ' + mb(stats.bytes) + ' MB served, latency ' + latency + ' ms per request');
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

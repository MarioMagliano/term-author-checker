// Runs the complete "annotated PDF" flow (search in stages, chunked upload,
// fallback, error texts) against an in-memory stand-in for Drive.
//
//   node test/annotate-flow.cjs [--out=annotated.pdf]
//
// Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const base = require('./pdf-memory.cjs');

function signed(buf) { return Array.from(buf, function(b) { return b > 127 ? b - 256 : b; }); }
function unsigned(arr) { return Buffer.from(Array.from(arr, function(b) { return b & 255; })); }

/** Minimal Drive: files by id, range download, resumable upload. */
function fakeDrive() {
  const files = {};
  const sessions = {};
  let seq = 0;
  const stats = { downloads: 0, maxDownload: 0, uploads: 0, wholeFileLoads: 0 };

  function put(name, buf) { const id = 'f' + (++seq); files[id] = { name: name, data: buf }; return id; }
  function fileObj(id) {
    if (!files[id]) throw new Error('No such file ' + id);
    return {
      getId: function() { return id; },
      getSize: function() { return files[id].data.length; },
      getUrl: function() { return 'https://drive.example/' + id; },
      setContent: function(str) { files[id].data = Buffer.from(str, 'utf8'); },
      getBlob: function() {
        return {
          getBytes: function() { stats.wholeFileLoads++; return signed(files[id].data); },
          getDataAsString: function(cs) { return files[id].data.toString(cs ? 'latin1' : 'utf8'); }
        };
      }
    };
  }
  function response(code, buf, headers) {
    return {
      getResponseCode: function() { return code; },
      getHeaders: function() { return headers || {}; },
      getContent: function() { return signed(buf || Buffer.alloc(0)); },
      getContentText: function(cs) { return (buf || Buffer.alloc(0)).toString(cs === 'ISO-8859-1' ? 'latin1' : 'utf8'); }
    };
  }
  function fetch(url, opts) {
    opts = opts || {};
    const method = (opts.method || 'get').toLowerCase();
    let m;
    if (method === 'get' && (m = /\/drive\/v3\/files\/([^?]+)\?alt=media/.exec(url))) {
      const data = files[m[1]].data;
      const r = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
      const part = data.subarray(parseInt(r[1], 10), parseInt(r[2], 10) + 1);
      stats.downloads++;
      stats.maxDownload = Math.max(stats.maxDownload, part.length);
      return response(206, part);
    }
    if (method === 'post' && url.indexOf('uploadType=resumable') !== -1) {
      const sid = 'https://upload.example/s' + (++seq);
      sessions[sid] = { meta: JSON.parse(opts.payload), total: parseInt(opts.headers['X-Upload-Content-Length'], 10), parts: [], got: 0 };
      return response(200, null, { Location: sid });
    }
    if (method === 'put' && sessions[url]) {
      const s = sessions[url];
      const r = /bytes (\d+)-(\d+)\/(\d+)/.exec(opts.headers['Content-Range']);
      if (parseInt(r[1], 10) !== s.got) throw new Error('Upload chunk at wrong offset');
      const chunk = unsigned(opts.payload);
      if (chunk.length !== parseInt(r[2], 10) - parseInt(r[1], 10) + 1) throw new Error('Upload chunk length mismatch');
      s.parts.push(chunk); s.got += chunk.length; stats.uploads++;
      if (s.got < s.total) return response(308, null, { Range: 'bytes=0-' + (s.got - 1) });
      const id = put(s.meta.name, Buffer.concat(s.parts));
      return response(200, Buffer.from(JSON.stringify({ id: id })));
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  }
  const folder = {
    getId: function() { return 'folder'; },
    createFile: function(a, content) {
      if (typeof a === 'string') return fileObj(put(a, Buffer.from(content, 'utf8')));
      return fileObj(put(a.name, unsigned(a.bytes)));
    }
  };
  return {
    files: files, stats: stats, put: put,
    globals: {
      DriveApp: { getFileById: fileObj },
      UrlFetchApp: { fetch: fetch, fetchAll: function(reqs) { return reqs.map(function(r) { return fetch(r.url, r); }); } },
      ScriptApp: { getOAuthToken: function() { return 'token'; } },
      Utilities: {
        getUuid: function() { return 'uuid' + (++seq); },
        newBlob: function(bytes, type, name) { return { bytes: bytes, name: name }; }
      },
      _tcFolder_: function() { return folder; },
      _tcDeleteFile_: function(id) { delete files[id]; },
      logAuditEvent_: function() {},
      getUserEmail_: function() { return 'tester'; }
    }
  };
}

function loadContext(drive) {
  const ctx = vm.createContext(Object.assign({
    console: console,
    Logger: { log: function() {} },
    _ct_: function(key) { return key; }
  }, drive.globals));
  base.FILES.forEach(function(f) {
    vm.runInContext(fs.readFileSync(path.join(base.ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

let failed = 0;
function expect(cond, what) {
  console.log((cond ? 'ok    ' : 'FAIL  ') + what);
  if (!cond) failed++;
}

function runToEnd(ctx, fileId, issues, budgetMs) {
  let r = ctx._driveAnnotatedStart_(fileId, 'manual.pdf', issues, Date.now(), budgetMs);
  let calls = 1, phases = {};
  while (!r.done) {
    phases[r.state.phase] = (phases[r.state.phase] || 0) + 1;
    const pct = ctx._driveAnnotatedPct_(r.state);
    if (!(pct >= 0 && pct <= 100)) throw new Error('Bad progress ' + pct);
    // State travels as JSON between calls (card parameter / web page).
    r = ctx._driveAnnotatedContinue_(JSON.parse(JSON.stringify(r.state)), Date.now(), budgetMs);
    if (++calls > 5000) throw new Error('Flow does not finish');
  }
  return { result: r, calls: calls, phases: phases };
}

function main() {
  const outArg = process.argv.filter(function(a) { return a.indexOf('--out=') === 0; })[0];
  const built = base.buildPdf(120, 45);
  const issues = base.buildIssues(150, built.lines);

  // 1) Normal flow in many small steps.
  let drive = fakeDrive();
  let ctx = loadContext(drive);
  ctx.DRIVE_ANNOT_MIN_SEARCH_MS = 0;
  ctx.DRIVE_UPLOAD_CHUNK = 256 * 1024;
  const srcId = drive.put('manual.pdf', built.pdf);
  const run = runToEnd(ctx, srcId, issues, 20);
  const outId = /\/d\/([^/]+)\//.exec(run.result.url)[1];
  const out = drive.files[outId].data;
  expect(run.phases.search > 1 && run.phases.upload > 1, 'search and upload both ran in several steps (' + run.calls + ' calls)');
  expect(out.subarray(0, built.pdf.length).equals(built.pdf), 'original bytes unchanged at the start of the result');
  expect(out.length > built.pdf.length, 'annotations appended');
  expect(drive.stats.wholeFileLoads <= run.phases.upload + 1, 'source PDF never loaded as a whole (only the small appendix file)');
  expect(Object.keys(drive.files).length === 2, 'temp files removed');
  expect(run.result.count === 150 && run.result.issuesTotal === 150, 'all findings counted');

  // Same annotations as one uninterrupted in-memory search.
  const text = built.pdf.toString('latin1');
  const reader = ctx._pdfStringReader_(text);
  const an = ctx._driveAnnotatedAnalyze_(reader);
  const direct = ctx._drivePdfComputeAnnotations_(an.doc, an.pages, issues, null);
  const expected = Buffer.from(ctx._driveAnnotatedAppendix_(reader, an, direct.pageAnnotations), 'latin1');
  expect(out.subarray(built.pdf.length).equals(expected), 'stepwise result identical to a single run');
  if (outArg) fs.writeFileSync(outArg.slice(6), out);

  // 2) Broken cross-reference: falls back to loading the whole (small) file.
  drive = fakeDrive(); ctx = loadContext(drive);
  const broken = Buffer.from(text.replace(/startxref\n\d+/, 'startxref\n7'), 'latin1');
  const r2 = ctx._driveAnnotatedStart_(drive.put('manual.pdf', broken), 'manual.pdf', issues.slice(0, 10), Date.now(), 200000);
  expect(r2.done && /drive\.example/.test(r2.url) && drive.stats.wholeFileLoads === 1, 'broken xref: fallback creates the PDF');
  expect(Object.keys(drive.files).length === 2, 'broken xref: temp file removed');

  // 3) Encrypted PDF: stops early with its own message.
  drive = fakeDrive(); ctx = loadContext(drive);
  const enc = Buffer.from(text.replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 3 0 R'), 'latin1');
  let msg = null;
  try { ctx._driveAnnotatedStart_(drive.put('manual.pdf', enc), 'manual.pdf', issues, Date.now(), 200000); }
  catch (e) { msg = ctx._driveAnnotateErrorText_(e); }
  expect(msg === 'd.annotEncrypted', 'encrypted: specific message');
  expect(drive.stats.wholeFileLoads === 0 && Object.keys(drive.files).length === 1, 'encrypted: no fallback, temp file removed');
  expect(ctx._driveAnnotateErrorText_(new Error('Drive download failed (HTTP 403).')) === 'd.annotContinueFailed', 'Drive error: message with cause');
  expect(ctx._driveAnnotateErrorText_(new Error('Catalog has no /Pages.')) === 'd.annotFailed', 'structure error: generic message');

  console.log(failed ? 'FAILED' : 'OK');
  process.exit(failed ? 1 : 0);
}

main();

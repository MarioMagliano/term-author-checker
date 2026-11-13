// Local harness for the PDF modules (not pushed by clasp: .cjs is no script extension).
//
// Builds a synthetic PDF and runs the annotation position search on it, then
// reports runtime and the peak of live heap memory during the search.
//
//   node --expose-gc test/pdf-memory.cjs [pages=470] [issues=400] [--check] [--out=annotated.pdf]
//
// --check: exit code 1 if results look wrong or peak heap exceeds the limit.
// --out:   write the annotated PDF, e.g. to open it in a viewer.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const FILES = ['PdfInflate.js', 'PdfTextPosition.js', 'PdfAnnotate.js', 'PdfShrink.js', 'DocPrompts.js', 'DriveAddon.js'];
const PEAK_LIMIT_MB = 60;

function loadContext() {
  const ctx = vm.createContext({
    console: console,
    Logger: { log: function() {} },
    _ct_: function(key) { return key; }
  });
  FILES.forEach(function(f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

const WORDS = ('valve pump hose nozzle trigger filter detergent pressure motor switch cable water inlet outlet ' +
  'check remove clean replace connect disconnect unit device operator service safety warning caution').split(' ');

// Deterministic pseudo random numbers, so every run sees the same document.
function rng(seed) {
  let s = seed >>> 0;
  return function() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function pageLines(pageNo, linesPerPage) {
  const rand = rng(pageNo * 7919 + 1);
  const lines = [];
  for (let l = 0; l < linesPerPage; l++) {
    const w = [];
    for (let k = 0; k < 11; k++) w.push(WORDS[Math.floor(rand() * WORDS.length)]);
    // One unique marker per line, used as the quote of a finding.
    w.splice(4, 0, 'mark' + pageNo + 'x' + l);
    lines.push(w.join(' '));
  }
  return lines;
}

/** Returns { pdf: Buffer, lines: [[line, ...] per page] }. */
function buildPdf(pageCount, linesPerPage) {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  function put(buf) { if (typeof buf === 'string') buf = Buffer.from(buf, 'latin1'); chunks.push(buf); pos += buf.length; }
  function obj(num, body) { offsets[num] = pos; put(num + ' 0 obj\n'); put(body); put('\nendobj\n'); }

  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const fontNum = 3, firstPage = 4;
  const kids = [];
  for (let p = 0; p < pageCount; p++) kids.push((firstPage + p * 2) + ' 0 R');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Count ' + pageCount + ' /MediaBox [0 0 595 842] /Kids [' + kids.join(' ') + '] >>');
  obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const allLines = [];
  for (let p = 0; p < pageCount; p++) {
    const lines = pageLines(p + 1, linesPerPage);
    allLines.push(lines);
    let content = 'BT /F1 9 Tf 12 TL 50 800 Td\n';
    lines.forEach(function(line) { content += '(' + line + ') Tj T*\n'; });
    content += 'ET\n';
    const packed = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const pageNum = firstPage + p * 2, contNum = pageNum + 1;
    obj(pageNum, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> /Contents ' + contNum + ' 0 R >>');
    offsets[contNum] = pos;
    put(contNum + ' 0 obj\n<< /Length ' + packed.length + ' /Filter /FlateDecode >>\nstream\n');
    put(packed);
    put('\nendstream\nendobj\n');
  }

  const size = firstPage + pageCount * 2;
  const xrefPos = pos;
  let xref = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
  for (let n = 1; n < size; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  put(xref);
  put('trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
  return { pdf: Buffer.concat(chunks), lines: allLines };
}

/**
 * Findings like the AI check reports them: most on the right page, some with a
 * wrong page number (found only by searching the other pages) and some whose
 * quote is nowhere in the document (worst case: every page gets searched).
 */
function buildIssues(count, lines) {
  const rand = rng(42);
  const pageCount = lines.length;
  const issues = [];
  for (let i = 0; i < count; i++) {
    const p = Math.floor(rand() * pageCount);
    const line = lines[p][Math.floor(rand() * lines[p].length)];
    const kind = i % 10;
    let quote = line.split(' ').slice(2, 8).join(' ');
    let reported = p + 1;
    let expected = p;
    if (kind === 7 || kind === 8) reported = 1 + Math.floor(rand() * pageCount); // wrong page
    if (kind === 9) { quote = 'this passage does not exist ' + i; expected = reported - 1; }
    issues.push({ type: 'grammar', original: quote, suggestion: 'fix', explanation: '', location: 'Page ' + reported,
                  _expectedPage: expected, _findable: kind !== 9 });
  }
  return issues;
}

function mb(n) { return Math.round(n / 1048576 * 10) / 10; }

function main() {
  const args = process.argv.slice(2).filter(function(a) { return a.indexOf('--') !== 0; });
  const check = process.argv.indexOf('--check') !== -1;
  const pageCount = parseInt(args[0], 10) || 470;
  const issueCount = parseInt(args[1], 10) || 400;
  if (!global.gc) console.log('(run with --expose-gc for exact memory numbers)');

  const built = buildPdf(pageCount, 45);
  const issues = buildIssues(issueCount, built.lines);
  const ctx = loadContext();

  // Peak heap is sampled every time a page gets interpreted (after a GC, so
  // only memory that is really still referenced counts).
  let peak = 0, sampling = true;
  const origExtract = ctx._pdfExtractPageGlyphs_;
  ctx._pdfExtractPageGlyphs_ = function(doc, page) {
    const r = origExtract(doc, page);
    if (!sampling) return r;
    if (global.gc) global.gc();
    const used = process.memoryUsage().heapUsed;
    if (used > peak) peak = used;
    return r;
  };

  const text = built.pdf.toString('latin1');
  const offsets = ctx._pdfScanObjectOffsets_(text);
  const doc = ctx._pdfOpenDoc_(text, offsets);
  const pages = ctx._pdfCollectPages_(text, offsets, ctx._pdfFindRootRef_(text), doc);

  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const result = ctx._drivePdfComputeAnnotations_(doc, pages, issues, null);
  const ms = Date.now() - t0;
  sampling = false;

  // Every findable quote must be highlighted on the page that contains it.
  let wrong = 0;
  const perPage = {};
  issues.forEach(function(issue) {
    const list = result.pageAnnotations[issue._expectedPage] || [];
    const idx = perPage[issue._expectedPage] = (perPage[issue._expectedPage] || 0);
    const ann = list.filter(function(a) { return a.contents.indexOf(issue.original) !== -1; })[0];
    if (!ann || !!ann.highlight !== issue._findable) wrong++;
    perPage[issue._expectedPage] = idx + 1;
  });
  const findable = issues.filter(function(i) { return i._findable; }).length;

  // Same search through the streamed path (structure read via cross-reference,
  // no images), interrupted after every few pages and resumed from JSON state.
  // Must give the same annotations; the appendix makes the output PDF.
  const reader = ctx._pdfStringReader_(text);
  const an = ctx._driveAnnotatedAnalyze_(reader);
  let resumed = null, state = null, stages = 0;
  const ctxDate = vm.runInContext('Date', ctx); // the script files see their own Date
  const realNow = ctxDate.now;
  while (!resumed || !resumed.done) {
    let ticks = 0;
    // Fake clock: time is "up" after 40 pages, whatever the machine speed.
    ctxDate.now = function() { return ticks++ < 40 ? 0 : 10; };
    try { resumed = ctx._drivePdfComputeAnnotations_(an.doc, an.pages, issues, null, { resume: state, stopAt: 5 }); }
    finally { ctxDate.now = realNow; }
    if (!resumed.done) state = JSON.parse(JSON.stringify(resumed.state));
    stages++;
  }
  const sameAsDirect = JSON.stringify(resumed.pageAnnotations) === JSON.stringify(result.pageAnnotations);
  const appended = ctx._driveAnnotatedAppendix_(reader, an, resumed.pageAnnotations);
  const outArg = process.argv.filter(function(a) { return a.indexOf('--out=') === 0; })[0];
  if (outArg) fs.writeFileSync(outArg.slice(6), Buffer.concat([built.pdf, Buffer.from(appended, 'latin1')]));

  console.log('pages ' + pages.length + ', findings ' + issues.length + ', pdf ' + mb(built.pdf.length) + ' MB');
  console.log('runtime        ' + ms + ' ms');
  console.log('peak live heap ' + mb(peak - before) + ' MB above start');
  console.log('positioned     ' + result.positioned + ' / ' + findable + ' findable, misplaced ' + wrong);

  console.log('resumed search ' + stages + ' stages, ' + (sameAsDirect ? 'same result' : 'DIFFERENT result') +
    ', appendix ' + Math.round(appended.length / 1024) + ' KB');

  if (check) {
    const ok = sameAsDirect && wrong === 0 && result.positioned === findable && mb(peak - before) <= PEAK_LIMIT_MB;
    console.log(ok ? 'OK' : 'FAILED (peak limit ' + PEAK_LIMIT_MB + ' MB)');
    process.exit(ok ? 0 : 1);
  }
}

if (require.main === module) main();
module.exports = { ROOT: ROOT, FILES: FILES, buildPdf: buildPdf, buildIssues: buildIssues };

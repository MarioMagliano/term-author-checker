// Runs the server side of the browser check (PdfBrowserApi.js) in Node with stand-ins for the
// Apps Script services (UrlFetchApp, Utilities, CacheService ...). The real code of
// _drivePdfRunBatch_, the Gemini request and the answer parser run unchanged.
//
//   node test/browser-api.cjs
//
// Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const checks = [];
function check(name, ok, detail) { checks.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : '')); }

const props = { GEMINI_API_KEY: 'k', AI_MODEL: 'test-model' };
const cacheStore = {};
const gemini = { calls: [], answer: null, code: 200 };
const audit = [];
const sheets = [];

function signed(buf) { return Array.from(buf, function(b) { return b > 127 ? b - 256 : b; }); }
function response(code, text) {
  return { getResponseCode: function() { return code; }, getContentText: function() { return text; }, getHeaders: function() { return {}; } };
}

const ctx = vm.createContext({
  console: console, Date: Date, JSON: JSON, Math: Math,
  Logger: { log: function() {} },
  PropertiesService: { getScriptProperties: function() { return { getProperty: function(k) { return props[k] || null; } }; },
                       getUserProperties: function() { return { getProperty: function() { return null; }, setProperty: function() {} }; } },
  CacheService: { getUserCache: function() { return { get: function(k) { return cacheStore[k] || null; }, put: function(k, v) { cacheStore[k] = v; } }; } },
  Utilities: {
    base64Decode: function(s) { return signed(Buffer.from(s, 'base64')); },
    base64Encode: function(b) { return Buffer.from(b.map(function(x) { return x & 255; })).toString('base64'); },
    sleep: function() {}, getUuid: function() { return 'uuid'; }
  },
  UrlFetchApp: {
    fetch: function(url, opts) { return ctx.__fetch(url, opts); },
    fetchAll: function(reqs) { return reqs.map(function(r) { return ctx.__fetch(r.url, r); }); }
  },
  // Drive and other services that the files only touch inside functions we do not call
  DriveApp: { getFileById: function(id) {
    if (id === 'missing') throw new Error('not found');
    return { getMimeType: function() { return id.indexOf('notpdf') === 0 ? 'text/plain' : 'application/pdf'; }, getName: function() { return 'Handbuch.pdf'; }, getSize: function() { return 12345; } };
  } },
  ScriptApp: { getOAuthToken: function() { return 'user-token'; } },
  Session: { getActiveUser: function() { return { getEmail: function() { return 'tim@example.com'; } }; } },
  SpreadsheetApp: {}, HtmlService: {}, CardService: {}
});
ctx.__fetch = function(url, opts) {
  gemini.calls.push({ url: url, body: JSON.parse(opts.payload || '{}') });
  return response(gemini.code, JSON.stringify(gemini.answer));
};

// The files as Apps Script sees them (all share one global scope).
['Code.js', 'CardI18n.js', 'Authorcheck.js', 'Rules.js', 'DocPrompts.js', 'PdfInflate.js', 'PdfTextPosition.js', 'PdfAnnotate.js',
 'PdfShrink.js', 'PdfAnnotateSearch.js', 'DriveAddon.js', 'PdfBrowserApi.js'].forEach(function(f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
});
// Stand-ins for what needs real Apps Script: audit log, report sheet.
ctx.logAuditEvent_ = function(user, action, details) { audit.push([user, action, details]); };
ctx._buildDrivePdfReportSheet_ = function(issues, fileName, lang) { sheets.push({ issues: issues, fileName: fileName, lang: lang }); return 'https://sheet.example/' + sheets.length; };
ctx._getUserEmail = function() { return 'tim@example.com'; };
// Prompt building reads rules and glossary (Sheets, Phrase): not what is tested here.
let promptBuilds = 0;
ctx._drivePdfPrompt_ = function(job) { promptBuilds++; return 'PROMPT[' + job.language + ',' + !!job.imagesRemoved + ']'; };
ctx._rulesLanguageSupported_ = function() { return true; };
ctx.apiGetRulesConfig = function() { return [{ IsEnabled: true, Name: 'X' }]; };
ctx._docPromptsFromRules_ = function() { return [{ title: 'Whole document rule' }]; };
ctx._docPromptNotes_ = function() { return ['A note']; };

const b64 = Buffer.from('%PDF-1.4 test').toString('base64');
function okAnswer(issues) { return { candidates: [{ content: { parts: [{ text: JSON.stringify({ issues: issues }) }] } }] }; }
function lastText() { return gemini.calls[gemini.calls.length - 1].body.contents[0].parts[0].text; }
function lastPdf() { return gemini.calls[gemini.calls.length - 1].body.contents[0].parts[1].inlineData; }

// ── apiPdfBrowserPrepare ─────────────────────────────────────────────────────
const link = 'https://drive.google.com/file/d/' + 'A'.repeat(33) + '/view?usp=sharing';
let prep = ctx.apiPdfBrowserPrepare(link, 'fr');
check('prepare: id taken from a Drive link, token and size returned',
  prep.fileId === 'A'.repeat(33) && prep.token === 'user-token' && prep.size === 12345 && prep.name === 'Handbuch.pdf');
check('prepare: language, whole-document prompts and notes returned',
  prep.language === 'fr' && prep.languageName === 'French' && prep.docPromptTitles[0] === 'Whole document rule' && prep.docNotes[0] === 'A note');
check('prepare: unknown language falls back to German', ctx.apiPdfBrowserPrepare(link, 'xx').language === 'de');
let err = '';
try { ctx.apiPdfBrowserPrepare('notpdf' + 'x'.repeat(20), 'de'); } catch (e) { err = e.message; }
check('prepare: a file that is not a PDF is refused', /not a PDF/.test(err), err);
err = '';
try { ctx.apiPdfBrowserPrepare('', 'de'); } catch (e) { err = e.message; }
check('prepare: empty input is refused', /file ID or link/.test(err), err);
props.GEMINI_API_KEY = '';
err = '';
try { ctx.apiPdfBrowserPrepare(link, 'de'); } catch (e) { err = e.message; }
check('prepare: missing Gemini key is reported early', /Gemini API Key missing/.test(err), err);
props.GEMINI_API_KEY = 'k';

// ── apiPdfBrowserCheckPart ───────────────────────────────────────────────────
gemini.answer = okAnswer([{ type: 'grammar', location: 'Page 9', original: 'abc', suggestion: 'abd', explanation: 'x' }, { type: 'style', original: '', suggestion: 'dropped' }]);
let r = ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 8, to: 12, split: true, imagesRemoved: true });
check('check part: issues returned, entries without quote dropped', r.issues && r.issues.length === 1 && r.issues[0].original === 'abc', JSON.stringify(r).slice(0, 80));
check('check part: the PDF goes to Gemini unchanged', lastPdf().mimeType === 'application/pdf' && lastPdf().data === b64);
check('check part: split part names the ORIGINAL pages',
  /pages 9 to 12 of the original document/.test(lastText()) && /first page in this file is page 9/.test(lastText()), lastText().slice(-160));
check('check part: prompt and model come from the settings', /^PROMPT\[de,true\]/.test(lastText()) && /test-model/.test(gemini.calls[0].url));
ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 1, split: false, imagesRemoved: true });
check('check part: not split -> no page hint', lastText().indexOf('original document') === -1);
const builds = promptBuilds;
ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 4, split: true, imagesRemoved: true });
ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 4, to: 8, split: true, imagesRemoved: true });
check('check part: the prompt is built once and reused for the next parts', promptBuilds === builds, promptBuilds + ' builds');
ctx.apiPdfBrowserCheckPart(b64, { language: 'en', from: 0, to: 4, split: true, imagesRemoved: false });
check('check part: another language or image setting gets its own prompt', /^PROMPT\[en,false\]/.test(lastText()));

gemini.code = 500;
r = ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 4, split: true });
check('check part: a failing AI request is reported as failed (the browser repeats it)', r.failed === true && !r.issues, JSON.stringify(r));
gemini.code = 200; gemini.answer = { candidates: [{ content: { parts: [{ text: 'not json' }] } }] };
r = ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 4, split: true });
check('check part: an answer that is not JSON counts as failed', r.failed === true);
err = '';
try { ctx.apiPdfBrowserCheckPart('', { language: 'de' }); } catch (e) { err = e.message; }
check('check part: no data is refused', /No PDF data/.test(err), err);

// ── Export and protocol ──────────────────────────────────────────────────────
ctx.apiPdfBrowserExportSheet([{ type: 'grammar', original: 'a'.repeat(5000), suggestion: 's', explanation: 'e', extra: 'ignored', evil: { x: 1 } }], 'Handbuch.pdf', 'zz');
check('export: only known fields, limited length, unknown language -> German',
  sheets.length === 1 && sheets[0].lang === 'de' && sheets[0].issues[0].original.length === 2000 && !('extra' in sheets[0].issues[0]) && sheets[0].fileName === 'Handbuch.pdf');
check('export: no list -> empty report, no error', (function() { ctx.apiPdfBrowserExportSheet(null, 'x.pdf', 'de'); return sheets[1].issues.length === 0; })());
ctx.apiPdfBrowserLogRun('Handbuch.pdf', 12, 60, ['5', '6']);
check('protocol: run is written to the audit log', audit.length === 1 && audit[0][1] === 'DRIVE_PDF_CHECK_RUN' && /12 issue\(s\), 60 part\(s\), browser, failed pages 5,6/.test(audit[0][2]), audit[0] && audit[0][2]);

const ok = checks.every(Boolean);
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);

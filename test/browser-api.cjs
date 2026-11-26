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
const gemini = { calls: [], answer: null, code: 200, fn: null };
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
    formatDate: function() { return '18.11.2026'; },
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
  Session: { getActiveUser: function() { return { getEmail: function() { return 'tim@example.com'; } }; }, getScriptTimeZone: function() { return 'Europe/Berlin'; } },
  SpreadsheetApp: {}, HtmlService: {}, CardService: {}
});
ctx.__fetch = function(url, opts) {
  const body = JSON.parse(opts.payload || '{}');
  gemini.calls.push({ url: url, body: body });
  const r = gemini.fn ? gemini.fn(body) : { code: gemini.code, answer: gemini.answer };
  return response(r.code, JSON.stringify(r.answer));
};

// The files as Apps Script sees them (all share one global scope).
['Code.js', 'CardI18n.js', 'Authorcheck.js', 'Rules.js', 'DocPrompts.js', 'PdfInflate.js', 'PdfTextPosition.js', 'PdfAnnotate.js',
 'PdfShrink.js', 'PdfAnnotateSearch.js', 'DriveAddon.js', 'DrivePdfWeb.js', 'PdfBrowserApi.js'].forEach(function(f) {
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
const DOC_RULES = [
  { name: 'CUSTOM_GEM_1', title: 'Gem 1: Chronologie', prompt: 'PROMPT-ONE', guide: '' },
  { name: 'CUSTOM_GEM_2', title: 'Gem 2: Daten', prompt: 'PROMPT-TWO', guide: '' },
  { name: 'CUSTOM_GEM_3', title: 'Gem 3: Werkzeuge', prompt: 'PROMPT-THREE', guide: '' }
];
// Synonym lookup (AI + termbase) has its own test (term-synonyms.cjs); here only how its result reaches the prompt.
let synBlock = '', synFails = false;
ctx._synContextForPdfPart_ = function() { if (synFails) throw new Error('Phrase down'); return synBlock; };
const realDocPromptsFromRules = ctx._docPromptsFromRules_;
ctx._docPromptsFromRules_ = function() { return DOC_RULES; };

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
  prep.language === 'fr' && prep.languageName === 'French' && JSON.stringify(prep.docPromptTitles) === JSON.stringify(DOC_RULES.map(function(r) { return r.title; })));
check('prepare: limit for the whole-document prompts (13 MB, or DOC_PROMPT_PDF_MAX_MB)', prep.docMaxBytes === 13 * 1024 * 1024 && !('docNotes' in prep) &&
  (function() { props.DOC_PROMPT_PDF_MAX_MB = '8'; const v = ctx.apiPdfBrowserPrepare(link, 'de').docMaxBytes; delete props.DOC_PROMPT_PDF_MAX_MB; return v === 8 * 1024 * 1024; })());
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

// ── Grenze fuer Gesamtdokument-Prompts (DOC_PROMPT_MAX) ─────────────────────────────
const docRule = function(n, on) { return { Name: 'CUSTOM_G' + n, Description: 'Gem ' + n, RuleKind: 'PROMPT', PromptScope: 'DOCUMENT', CustomPrompt: 'p' + n, IsEnabled: on !== false }; };
const manyRules = [1, 2, 3, 4, 5, 6, 7].map(function(n) { return docRule(n); }).concat([docRule(8, false)]);
const titlesOf = function(list) { return list.map(function(p) { return p.title; }).join(','); };
check('limit: five whole-document prompts by default, the rest is left out', titlesOf(realDocPromptsFromRules(manyRules)) === 'Gem 1,Gem 2,Gem 3,Gem 4,Gem 5');
props.DOC_PROMPT_MAX = '8';
check('limit: DOC_PROMPT_MAX raises it, switched-off prompts never run', titlesOf(realDocPromptsFromRules(manyRules)) === 'Gem 1,Gem 2,Gem 3,Gem 4,Gem 5,Gem 6,Gem 7');
props.DOC_PROMPT_MAX = '99';
check('limit: at most 12', ctx._docPromptMax_() === 12);
['abc', '0', '-3', ''].forEach(function(v) { props.DOC_PROMPT_MAX = v; });
check('limit: invalid values fall back to 5', (function() { return ['abc', '0', '-3', ''].every(function(v) { props.DOC_PROMPT_MAX = v; return ctx._docPromptMax_() === 5; }); })());
delete props.DOC_PROMPT_MAX;
const origRulesFn = ctx.apiGetRulesConfig;
ctx.apiGetRulesConfig = function() { return manyRules; };
let lim = ctx.apiPdfBrowserPrepare(link, 'de');
check('prepare: prompts over the limit are reported, not dropped silently', lim.docPromptMax === 5 && JSON.stringify(lim.docPromptsSkipped) === JSON.stringify(['Gem 6', 'Gem 7']), JSON.stringify(lim.docPromptsSkipped));
props.DOC_PROMPT_MAX = '7';
lim = ctx.apiPdfBrowserPrepare(link, 'de');
check('prepare: nothing is left out when the limit is high enough', lim.docPromptMax === 7 && lim.docPromptsSkipped.length === 0);
delete props.DOC_PROMPT_MAX;
ctx.apiGetRulesConfig = origRulesFn;

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

// ── apiPdfBrowserDocPrompts (Gesamtdokument-Prompts, z. B. Gems) ────────────────────
function gemAnswer(report, issues) {
  return { candidates: [{ content: { parts: [{ text: report + '\n===TERMCHECK_FINDINGS===\n' + JSON.stringify({ issues: issues || [] }) }] }, finishReason: 'STOP' }] };
}
// Answer depends on which prompt is in the request.
gemini.fn = function(body) {
  const text = body.contents[0].parts[0].text;
  if (text.indexOf('PROMPT-THREE') !== -1 && gemini.failThree) return { code: 503, answer: {} };
  const which = text.indexOf('PROMPT-ONE') !== -1 ? 1 : text.indexOf('PROMPT-TWO') !== -1 ? 2 : 3;
  return { code: 200, answer: gemAnswer('Report ' + which, which === 2 ? [] : [{ location: 'Page 3', original: 'quote ' + which, suggestion: 'fix ' + which, explanation: 'why ' + which, replaceable: false }, { original: '', suggestion: 'dropped' }]) };
};
gemini.calls.length = 0;
let dr = ctx.apiPdfBrowserDocPrompts({ language: 'de', fileName: 'Handbuch.pdf', pages: 462, sizeBytes: 9 * 1048576, mode: 'pdf', b64: b64 });
check('doc prompts (PDF): every prompt gets its own request with the whole PDF', gemini.calls.length === 3 && gemini.calls.every(function(c) { return c.body.contents[0].parts[1].inlineData.data === b64; }));
check('doc prompts (PDF): the prompt text names the document and says the PDF is attached',
  /Document: Handbuch\.pdf/.test(gemini.calls[0].body.contents[0].parts[0].text) && /attached as a PDF/.test(gemini.calls[0].body.contents[0].parts[0].text) && /Total pages: 462/.test(gemini.calls[0].body.contents[0].parts[0].text));
check('doc prompts (PDF): reports and findings per prompt, findings carry the prompt title as rule',
  JSON.stringify(dr.indexes) === '[0,1,2]' && dr.reports[0].markdown === 'Report 1' && dr.reports[0].issues.length === 1 &&
  dr.reports[0].issues[0].type === 'prompt' && dr.reports[0].issues[0].rule === 'Gem 1: Chronologie' && dr.reports[0].issues[0].original === 'quote 1' &&
  dr.reports[1].issues.length === 0 && dr.reports[2].issues[0].rule === 'Gem 3: Werkzeuge', JSON.stringify(dr.reports[0].issues));

gemini.calls.length = 0;
dr = ctx.apiPdfBrowserDocPrompts({ language: 'de', fileName: 'Handbuch.pdf', pages: 2, sizeBytes: 15 * 1048576, mode: 'text', indexes: [2, 0, 2, 7, -1, 'x'],
  texts: ['Seite eins ' + 'Wort '.repeat(60), 'Seite zwei ' + 'Text '.repeat(60)] });
const textReq = gemini.calls.length ? gemini.calls[0].body.contents[0].parts : [];
check('doc prompts (text): only the chosen prompts run (duplicates and invalid numbers are ignored)', gemini.calls.length === 2 && JSON.stringify(dr.indexes) === '[2,0]', gemini.calls.length + ' calls, ' + JSON.stringify(dr.indexes));
check('doc prompts (text): the text of all pages follows with page markers, no PDF is attached',
  textReq.length === 1 && /=== Page 1 of 2 ===\nSeite eins/.test(textReq[0].text) && /=== Page 2 of 2 ===\nSeite zwei/.test(textReq[0].text) && /without images/.test(textReq[0].text));
check('doc prompts (text): the reports say that the page text was used', dr.reports.every(function(r) { return /text of all 2 pages/.test(r.note); }) && dr.reports[0].title === 'Gem 3: Werkzeuge', dr.reports[0].note);
check('doc prompts (text): the text mode is written to the protocol', audit.some(function(a) { return a[1] === 'DOC_PROMPT_TEXT_MODE' && /browser/.test(a[2]); }));

gemini.calls.length = 0;
dr = ctx.apiPdfBrowserDocPrompts({ language: 'de', fileName: 'Scan.pdf', pages: 3, sizeBytes: 20 * 1048576, mode: 'text', texts: ['', ' ', 'kurz'] });
check('doc prompts (text): a PDF without readable text gets a clear message and no request',
  gemini.calls.length === 0 && dr.reports.length === 3 && dr.reports.every(function(r) { return /no readable text/.test(r.error) && /20 MB/.test(r.error); }), dr.reports[0] && dr.reports[0].error);

gemini.failThree = true;
dr = ctx.apiPdfBrowserDocPrompts({ language: 'de', fileName: 'x.pdf', pages: 1, mode: 'pdf', b64: b64 });
check('doc prompts: one failing prompt does not hide the others', dr.reports[2].error && dr.reports[2].code === 503 && !dr.reports[0].error && !dr.reports[1].error, JSON.stringify(dr.reports[2]));
gemini.failThree = false;
err = '';
try { ctx.apiPdfBrowserDocPrompts({ language: 'de', mode: 'pdf' }); } catch (e) { err = e.message; }
check('doc prompts (PDF): no data is refused', /No PDF data/.test(err), err);
check('doc prompts: no prompt selected -> nothing to do', JSON.stringify(ctx.apiPdfBrowserDocPrompts({ language: 'de', mode: 'pdf', b64: b64, indexes: [9] })) === '{"indexes":[],"reports":[]}');
gemini.fn = null;

// ── apiPdfBrowserDocReport ──────────────────────────────────────────────────────
const built = [];
ctx._buildDocPromptReport_ = function(fileName, reports, folderKey, meta) { built.push({ fileName: fileName, reports: reports, folderKey: folderKey, meta: meta }); return 'https://doc.example/report'; };
const rep1 = ctx.apiPdfBrowserDocReport('Handbuch.pdf', [{ title: 'Gem 1', markdown: '# ok', note: 'n', truncated: true, issues: [{ original: 'x', severity: 'critical', evidence: 'Seite 3', evil: 1 }], evil: 1 }, { title: 'Gem 2', error: 'boom' }, { title: 'T'.repeat(500), markdown: 'm'.repeat(500000) }]);
check('doc report: Google Doc is created from the reports and the link comes back', rep1.url === 'https://doc.example/report' && built.length === 1 && built[0].folderKey === 'pdfs' && built[0].fileName === 'Handbuch.pdf', JSON.stringify(rep1).slice(0, 100));
check('doc report: only known fields, limited length, findings kept with severity and evidence',
  built[0].reports.length === 3 && !('evil' in built[0].reports[0]) && built[0].reports[0].truncated === true &&
  built[0].reports[2].title.length === 200 && built[0].reports[2].markdown.length === 400000 &&
  built[0].reports[0].issues.length === 1 && built[0].reports[0].issues[0].severity === 'kritisch' && built[0].reports[0].issues[0].evidence === 'Seite 3' &&
  built[0].reports[0].issues[0].type === 'prompt' && !('evil' in built[0].reports[0].issues[0]) && built[0].reports[2].issues.length === 0);
built.length = 0;
ctx.apiPdfBrowserDocReport('Handbuch.pdf', [{ title: 'G', markdown: 'm' }], { language: 'en', pages: 462.7, mode: 'mixed', pageChecks: [{ label: 'Grammar', n: 3 }, { label: 'x'.repeat(200), n: -4 }, null], evil: 1 });
check('doc report: header data is sanitized (language, pages, mode, numbers per check)',
  built[0].meta.language === 'en' && built[0].meta.pages === 462 && built[0].meta.mode === 'mixed' && built[0].meta.pageChecks.length === 3 &&
  built[0].meta.pageChecks[0].n === 3 && built[0].meta.pageChecks[1].label.length === 60 && built[0].meta.pageChecks[1].n === 0 && !('evil' in built[0].meta), JSON.stringify(built[0].meta));
built.length = 0;
ctx.apiPdfBrowserDocReport('Handbuch.pdf', [{ title: 'G', markdown: 'm' }], { language: 'xx', pages: 'abc', mode: 'weird' });
check('doc report: unknown language -> German, nonsense pages/mode are ignored', built[0].meta.language === 'de' && built[0].meta.pages === 0 && built[0].meta.mode === '', JSON.stringify(built[0].meta));
check('doc report: nothing to report -> no document', (function() { built.length = 0; const r = ctx.apiPdfBrowserDocReport('x.pdf', []); return r.url === '' && built.length === 0; })());
audit.length = 0;

// ── Export and protocol ──────────────────────────────────────────────────────
ctx.apiPdfBrowserExportSheet([{ type: 'grammar', original: 'a'.repeat(5000), suggestion: 's', explanation: 'e', extra: 'ignored', evil: { x: 1 } }], 'Handbuch.pdf', 'zz');
check('export: only known fields, limited length, unknown language -> German',
  sheets.length === 1 && sheets[0].lang === 'de' && sheets[0].issues[0].original.length === 2000 && !('extra' in sheets[0].issues[0]) && sheets[0].fileName === 'Handbuch.pdf');
check('export: no list -> empty report, no error', (function() { ctx.apiPdfBrowserExportSheet(null, 'x.pdf', 'de'); return sheets[1].issues.length === 0; })());
ctx.apiPdfBrowserLogRun('Handbuch.pdf', 12, 60, ['5', '6']);
check('protocol: run is written to the audit log', audit.length === 1 && audit[0][1] === 'DRIVE_PDF_CHECK_RUN' && /12 issue\(s\), 60 part\(s\), browser, failed pages 5,6/.test(audit[0][2]), audit[0] && audit[0][2]);

// ── Synonyms and homonyms in the PDF check ──
synBlock = 'APPROVED TERMINOLOGY ...\n- Bürstenkopf | meaning: Werkzeugeinheit';
gemini.answer = okAnswer([]); gemini.code = 200; gemini.fn = null;
ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 2, split: false, imagesRemoved: false });
check('part: approved terms of the pages are added to the prompt', /TERMINOLOGY FOR THESE PAGES/.test(lastText()) && lastText().indexOf('- Bürstenkopf | meaning') !== -1, lastText().slice(0, 120));
synBlock = '';
ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 2, split: false, imagesRemoved: false });
check('part: no approved terms found, prompt unchanged', lastText().indexOf('TERMINOLOGY FOR THESE PAGES') === -1);
synFails = true;
const failRes = ctx.apiPdfBrowserCheckPart(b64, { language: 'de', from: 0, to: 2, split: false, imagesRemoved: false });
check('part: failing synonym lookup does not stop the check', !failRes.failed && Array.isArray(failRes.issues));
synFails = false;

// ── Page and Drive button: the add-on opens the browser check as a pop-up and starts it ──
const FID = 'F'.repeat(33);
let tplVars = null;
ctx.HtmlService = {
  XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
  createTemplateFromFile: function() {
    tplVars = {};
    const t = tplVars;
    t.evaluate = function() { const o = { setTitle: function() { return o; }, setXFrameOptionsMode: function() { return o; }, addMetaTag: function() { return o; } }; return o; };
    return t;
  }
};
ctx._renderPdfBrowserPage_({ parameter: { fileId: FID, start: '1' } });
check('page: start=1 with a file starts the check, debug stays off', tplVars.autoStart === true && tplVars.debug === false);
ctx._renderPdfBrowserPage_({ parameter: { fileId: FID } });
check('page: a link without start=1 does not start anything', tplVars.autoStart === false);
ctx._renderPdfBrowserPage_({ parameter: { start: '1' } });
check('page: start=1 without a file does not start', tplVars.autoStart === false);
ctx._renderPdfBrowserPage_({ parameter: { fileId: FID, debug: '1' } });
check('page: debug=1 shows the diagnostics', tplVars.debug === true && tplVars.autoStart === false);

let opened = null;
ctx.CardService = {
  OpenAs: { OVERLAY: 'OVERLAY', FULL_SIZE: 'FULL_SIZE' },
  newOpenLink: function() { const o = { setUrl: function(u) { o.url = u; return o; }, setOpenAs: function(a) { o.openAs = a; return o; } }; return o; },
  newActionResponseBuilder: function() { const b = { setOpenLink: function(l) { opened = l; return b; }, build: function() { return { link: opened }; } }; return b; }
};
props.WEBAPP_URL = 'https://script.google.com/a/macros/karcher.com/s/AKfycbxyz/exec';
ctx.apiOpenDrivePdfWindow({ parameters: { fileId: FID }, formInput: { language: 'fr' } });
check('drive button: opens the browser check for the chosen file and language and starts it',
  opened && opened.url === 'https://script.google.com/a/macros/karcher.com/s/AKfycbxyz/exec?page=pdfbrowser&fileId=' + FID + '&lang=fr&start=1', opened && opened.url);
check('drive button: opens as a pop-up', opened && opened.openAs === 'OVERLAY');

const ok = checks.every(Boolean);
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);

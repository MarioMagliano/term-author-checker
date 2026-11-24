// Tests the report (Google Doc) of the whole-document prompts: severity, structure, title, evidence.
// _docReportHtml_ is a pure function; the Drive upload is replaced by a recording stand-in.
//
//   node test/doc-report.cjs
//
// Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const checks = [];
function check(name, ok, detail) { checks.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + String(detail).slice(0, 160) + ')' : '')); }

const uploads = [];
const ctx = vm.createContext({
  console: console, Date: Date, JSON: JSON, Math: Math,
  Logger: { log: function() {} },
  PropertiesService: { getUserProperties: function() { return { getProperty: function() { return null; } }; }, getScriptProperties: function() { return { getProperty: function() { return null; } }; } },
  Session: { getScriptTimeZone: function() { return 'Europe/Berlin'; }, getActiveUser: function() { return { getEmail: function() { return 'tim@example.com'; } }; } },
  Utilities: {
    formatDate: function(d, tz, fmt) { return fmt === 'yyyy-MM-dd' ? '2026-11-19' : '19.11.2026 14:30'; },
    getUuid: function() { return 'abc-def'; },
    newBlob: function(s) { return { getBytes: function() { return s; } }; }
  },
  ScriptApp: { getOAuthToken: function() { return 'tok'; } },
  UrlFetchApp: { fetch: function(url, opts) {
    uploads.push({ url: url, payload: String(opts.payload) });
    return { getResponseCode: function() { return 200; }, getContentText: function() { return JSON.stringify({ id: 'DOC1', webViewLink: 'https://docs.example/DOC1' }); } };
  } },
  _tcFolder_: function(key) { return { getId: function() { return 'folder-' + key; } }; },
  logAuditEvent_: function() {}, getUserEmail_: function() { return 'tim@example.com'; }
});
['CardI18n.js', 'DocPrompts.js'].forEach(function(f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); });

const issue = function(loc, sev, extra) {
  return Object.assign({ type: 'prompt', rule: 'x', location: loc, original: 'Zitat ' + loc, suggestion: 'Besser ' + loc, explanation: 'Problem bei ' + loc, severity: sev, evidence: '' }, extra || {});
};

// ── Schwere ──────────────────────────────────────────────────────────────────
const sev = ctx._docSeverity_;
check('severity: German values', sev('kritisch') === 'kritisch' && sev('Mittel') === 'mittel' && sev(' NIEDRIG ') === 'niedrig');
check('severity: English and other spellings are mapped', sev('critical') === 'kritisch' && sev('high') === 'kritisch' && sev('medium') === 'mittel' && sev('major') === 'mittel' && sev('low') === 'niedrig' && sev('minor') === 'niedrig');
check('severity: unknown or missing means no severity', sev('') === '' && sev(undefined) === '' && sev(null) === '' && sev('wichtig') === '');
check('severity: older prompts put it at the start of the explanation', sev('', 'Norm: X | Schwere: kritisch | Text') === 'kritisch' && sev(undefined, 'Schwere: Mittel') === 'mittel' && sev('niedrig', 'Schwere: kritisch') === 'niedrig');

// Findings from the AI answer: severity and evidence are taken over.
const mapped = ctx._docPromptIssues_({ title: 'Gem 1' }, [
  { location: 'Page 4', original: ' Zitat ', suggestion: '', explanation: 'Warum', severity: 'critical', evidence: ' Seite 9: "…" ' },
  { original: 'ohne Schwere', suggestion: 'x', explanation: 'Schwere: mittel | Text' },
  { original: '', suggestion: 'weg' }
]);
check('findings: severity and evidence are kept, empty quotes dropped', mapped.length === 2 && mapped[0].severity === 'kritisch' && mapped[0].evidence === 'Seite 9: "…"' &&
  mapped[0].rule === 'Gem 1' && mapped[0].type === 'prompt' && mapped[0].suggestion === '–' && mapped[1].severity === 'mittel' && mapped[1].evidence === '', JSON.stringify(mapped[0]));
const reqText = ctx._docPromptText_({ title: 'T', prompt: 'MEIN-PROMPT', guide: '' }, { fileName: 'a.pdf', pages: 3, isPdf: true });
check('prompt text asks for severity, evidence and a quote for every finding',
  /"severity"/.test(reqText) && /"evidence"/.test(reqText) && /exactly one of "kritisch", "mittel", "niedrig"/.test(reqText) && /Support every finding/.test(reqText) && /Never invent a source/.test(reqText));

// ── Titel ────────────────────────────────────────────────────────────────────
check('title: named like the checked document', ctx._docReportTitle_('Betriebsanleitung HD 9.pdf', '2026-11-19', 'de') === 'Betriebsanleitung HD 9 – Prüfbericht 2026-11-19');
check('title: English, no date, any case of .pdf', ctx._docReportTitle_('Manual.PDF', '', 'en') === 'Manual – Review report');
check('title: long names are shortened, empty names get a fallback', ctx._docReportTitle_('x'.repeat(400) + '.pdf', '', 'de').length < 200 && /^Document /.test(ctx._docReportTitle_('', '', 'de')));

// ── Aufbau des Berichts ─────────────────────────────────────────────────────
const reports = [
  { title: 'Gem 1: Chronologie', markdown: '# Ergebnis\nAlles geprüft.\n\n## Details\n- Punkt **eins**', note: 'Seitentext genutzt', issues: [
      issue('Page 12', 'kritisch', { evidence: 'Seite 105: „Der Druck beträgt 25 MPa“', explanation: 'Widerspruch zu Seite 105' }),
      issue('Page 3', 'mittel', { suggestion: '–' }),
      issue('Page 40', 'niedrig'),
      issue('Page 7', '') ] },
  { title: 'Normprüfung <b>Hochdruckreiniger</b>', markdown: 'Bericht B', issues: [ issue('Seite 5, Kap. 2', 'kritisch', { evidence: 'EN 60335-2-79: Warnhinweis Hochdruckstrahl' }) ] },
  { title: 'Gem 3', error: 'AI request failed (503).', issues: [] }
];
const meta = { date: '19.11.2026 14:30', language: 'de', pages: 462, mode: 'mixed', pageChecks: [{ label: 'Grammatik', n: 244 }, { label: 'Terminologie', n: 18 }] };
const html = ctx._docReportHtml_('Betriebsanleitung <HD>.pdf', reports, meta);
const at = function(s) { return html.indexOf(s); };

check('report: title like the document, with "Prüfbericht"', /<h1>Betriebsanleitung &lt;HD&gt; – Prüfbericht<\/h1>/.test(html), html.slice(html.indexOf('<h1>'), html.indexOf('<h1>') + 90));
check('report: header table with document, date, pages, basis, checks, number of findings',
  /Dokument<\/b><\/td><td>Betriebsanleitung &lt;HD&gt;\.pdf/.test(html) && /Geprüft am/.test(html) && /19\.11\.2026 14:30/.test(html) && /462/.test(html) &&
  /bei einzelnen Prüfungen Text aller Seiten/.test(html) && /Funde<\/b><\/td><td>5</, html.slice(0, 200));
check('report: three parts in the right order (summary, checklist, full explanation)',
  at('1 Zusammenfassung') > 0 && at('2 Checkliste: Was ist zu tun?') > at('1 Zusammenfassung') && at('3 Umfassende Erklärung') > at('2 Checkliste: Was ist zu tun?'));
check('checklist: grouped by severity with counts, in the order critical, medium, low, no severity',
  at('Kritisch (2)') > 0 && at('Mittel (1)') > at('Kritisch (2)') && at('Niedrig (1)') > at('Mittel (1)') && at('Ohne Einstufung (1)') > at('Niedrig (1)'));
check('checklist: every item is a tick box with a number, sorted by page within a severity',
  at('☐ <span style="color:#C62828">K1</span> · Seite 5, Kap. 2') > 0 && at('K2</span> · Page 12') > at('K1</span>') &&
  at('☐ <span style="color:#E65100">M1</span> · Page 3') > 0 && at('N1') > 0 && at('O1') > 0);
check('checklist: place, quote, problem, evidence and recommendation are given per item',
  /<b>Zitat:<\/b> „Zitat Page 12“/.test(html) && /<b>Problem:<\/b> Widerspruch zu Seite 105/.test(html) && /<b>Beleg:<\/b> Seite 105: „Der Druck beträgt 25 MPa“/.test(html) && /<b>Empfehlung:<\/b> Besser Page 12/.test(html));
check('checklist: no "Beleg" line when there is no evidence, no recommendation when it is only a dash',
  (html.match(/<b>Beleg:<\/b>/g) || []).length === 2 && !/<b>Empfehlung:<\/b> –/.test(html) && (html.match(/<b>Empfehlung:<\/b>/g) || []).length === 4);
check('summary: table with the checks and the number of findings per severity, failed check marked, totals',
  /<th>Prüfung<\/th><th>Kritisch<\/th><th>Mittel<\/th><th>Niedrig<\/th><th>Ohne Einstufung<\/th><th>Gesamt<\/th>/.test(html) &&
  /Gem 1: Chronologie<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td><b>4<\/b>/.test(html) && /Gem 3 <i>\(nicht gelaufen\)<\/i>/.test(html) && /<td><b>Gesamt<\/b><\/td><td><b>2<\/b><\/td><td><b>1<\/b><\/td><td><b>1<\/b><\/td><td><b>1<\/b><\/td><td><b>5<\/b>/.test(html));
check('summary: the most important (critical) points come first, with numbers', at('Wichtigste Punkte') > 0 && /<li><b>K1<\/b> · Seite 5, Kap. 2/.test(html) && /<li><b>K2<\/b> · Page 12/.test(html));
check('summary: numbers of the page check are shown, with a pointer to PDF and sheet', /Grammatik: <b>244<\/b> · Terminologie: <b>18<\/b>/.test(html) && /kommentierten PDF und im Sheet/.test(html));
check('explanation: the full report of each check, headings moved below the part heading',
  /<h3>Gem 1: Chronologie<\/h3>/.test(html) && /<h3>Ergebnis<\/h3>/.test(html) && /<h4>Details<\/h4>/.test(html) && /<b>eins<\/b>/.test(html) && /Seitentext genutzt/.test(html));
check('explanation: a failed check is named with its error', /Diese Prüfung ist fehlgeschlagen: AI request failed \(503\)\./.test(html));
check('security: titles, quotes and explanations are escaped', html.indexOf('<b>Hochdruckreiniger</b>') === -1 && /Normprüfung &lt;b&gt;Hochdruckreiniger&lt;\/b&gt;/.test(html));

const noCrit = ctx._docReportHtml_('x.pdf', [{ title: 'A', markdown: 'm', issues: [issue('Page 1', 'mittel')] }], { language: 'de' });
check('report: groups without findings and the "most important points" are left out', noCrit.indexOf('Kritisch (') === -1 && noCrit.indexOf('Niedrig (') === -1 && noCrit.indexOf('Wichtigste Punkte') === -1 && /Mittel \(1\)/.test(noCrit));
const none = ctx._docReportHtml_('x.pdf', [{ title: 'A', markdown: 'Alles gut.', issues: [] }], { language: 'de' });
check('report: no findings says so and still has all three parts', /Keine Funde\./.test(none) && /3 Umfassende Erklärung/.test(none) && /Alles gut\./.test(none));
const en = ctx._docReportHtml_('x.pdf', [{ title: 'A', markdown: 'm', issues: [issue('Page 1', 'kritisch')] }], { language: 'en', mode: 'text' });
check('report: English labels for other languages', /Review report/.test(en) && /Checklist: what to do/.test(en) && /Critical \(1\)/.test(en) && /Text of all pages/.test(en) && /Full explanation/.test(en));
const many = ctx._docReportHtml_('x.pdf', [{ title: 'A', markdown: '', issues: Array.from({ length: 8 }, function(_, i) { return issue('Page ' + (i + 1), 'kritisch'); }) }], {});
check('summary: at most five most important points', (many.match(/<li><b>K\d<\/b>/g) || []).length === 5 && /K8/.test(many));

// ── Hilfen ───────────────────────────────────────────────────────────────────
check('mode: pdf, text or mixed from the notes of the reports', ctx._docReportMode_([{ title: 'a' }, { title: 'b' }]) === 'pdf' && ctx._docReportMode_([{ note: 'n' }, { note: 'n' }]) === 'text' &&
  ctx._docReportMode_([{ note: 'n' }, {}]) === 'mixed' && ctx._docReportMode_([{ error: 'x' }]) === '' && ctx._docReportMode_([{ error: 'x', note: 'n' }, { }]) === 'pdf');
const pc = ctx._docReportPageChecks_([{ type: 'grammar' }, { type: 'grammar' }, { type: 'prompt', rule: 'Gem' }, { type: 'terminology' }, { type: 'weird' }, {}]);
check('page check numbers: counted per type, whole-document findings are not counted', JSON.stringify(pc.map(function(p) { return p.n; })) === '[2,1,1,1]' && pc[0].label === 'Grammar', JSON.stringify(pc));
check('page check numbers: unknown types keep their own name as label', pc.some(function(p) { return p.label === 'weird'; }) && pc.some(function(p) { return p.label === 'Style'; }));

// ── Anlegen des Google Docs ─────────────────────────────────────────────────
const url = ctx._buildDocPromptReport_('Betriebsanleitung HD 9.pdf', reports, 'pdfs', { language: 'de', pages: 462, mode: 'pdf', pageChecks: [] });
const up = uploads[uploads.length - 1];
const metaJson = JSON.parse(/Content-Type: application\/json; charset=UTF-8\r\n\r\n(\{.*?\})\r\n--/.exec(up.payload)[1]);
check('upload: the Google Doc is named like the checked document and lies in the report folder',
  url === 'https://docs.example/DOC1' && metaJson.name === 'Betriebsanleitung HD 9 – Prüfbericht 2026-11-19' && metaJson.mimeType === 'application/vnd.google-apps.document' && metaJson.parents[0] === 'folder-pdfs', JSON.stringify(metaJson));
check('upload: the HTML of the report is what is converted', /<h1>Betriebsanleitung HD 9 – Prüfbericht<\/h1>/.test(up.payload) && /19\.11\.2026 14:30/.test(up.payload) && /K1/.test(up.payload));
const before = uploads.length;
check('upload: nothing to report means no document', ctx._buildDocPromptReport_('x.pdf', [{ title: 'A', error: 'boom', issues: [] }], 'pdfs', {}) === '' && uploads.length === before);
const fin = ctx._finishDocPromptReports_('x.pdf', reports, 'pdfs', [], { language: 'de' });
check('finish: link and the numbers per check', fin.url === 'https://docs.example/DOC1' && fin.items.length === 3 && fin.items[0].findings === 4 && fin.items[2].error === 'AI request failed (503).');

const ok = checks.every(Boolean);
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);

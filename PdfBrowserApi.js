// ============================================================================
// PDF IM BROWSER (Prototyp): Server-Seite
// ----------------------------------------------------------------------------
// Grosse PDFs scheiterten in Apps Script an Speicher und Laufzeit - schon beim
// Oeffnen, noch vor der eigentlichen Pruefung. Beim PDF-Fenster im Browser
// (PdfBrowser.html + PdfBrowserClient.html + PdfWorkerSource.html) liest deshalb
// der Browser die Datei selbst: stueckweise per HTTP-Range direkt von Drive,
// mit dem Token der Person, die die Seite geoeffnet hat (die Web-App laeuft als
// der zugreifende Nutzer, siehe appsscript.json). Die PDF geht nie durch Apps
// Script. Hier liegt nur, was der Browser nicht selbst kann: Datei pruefen und
// das Token geben.
//
// Aufruf: <Web-App-URL>?page=pdfbrowser[&fileId=...]
// ============================================================================

// Aus doGet (Code.js): Seite fuer ?page=pdfbrowser ausliefern.
function _renderPdfBrowserPage_(e) {
  var p = (e && e.parameter) || {};
  var tpl = HtmlService.createTemplateFromFile('PdfBrowser');
  tpl.fileId = String(p.fileId || '');
  tpl.languages = DRIVE_PDF_LANGUAGES;
  // Wie viele Pakete gleichzeitig an Gemini gehen (mehr = schneller, aber eher Limits des Proxys).
  tpl.parallel = Math.max(1, Math.min(12, parseInt(p.parallel, 10) || 6));
  var wanted = String(p.lang || '');
  var last = '';
  try { last = PropertiesService.getUserProperties().getProperty(DRIVE_PDF_LAST_LANG_KEY) || ''; } catch (propErr) {}
  var known = function(code) { return DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === code; }); };
  tpl.lastLang = known(wanted) ? wanted : (known(last) ? last : 'de');
  return tpl.evaluate()
    .setTitle('Kärcher TermCheck – PDF im Browser (Prototyp)')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Datei-ID aus einer ID oder einer Drive-Adresse (.../d/<id>/..., ...?id=<id>).
function _pdfBrowserFileId_(input) {
  var s = String(input || '').trim();
  var m = /\/d\/([-\w]{20,})/.exec(s) || /[?&]id=([-\w]{20,})/.exec(s) || /^([-\w]{20,})$/.exec(s);
  return m ? m[1] : '';
}

/**
 * Prueft die Datei und gibt dem Browser, was er zum Lesen braucht: Name, Groesse
 * und das OAuth-Token der angemeldeten Person (Drive-Zugriff, ca. 1 Stunde
 * gueltig). Das Token gehoert der Person selbst und geht nur an ihren eigenen
 * Browser; fremde Dateien sind damit nicht lesbar.
 */
function apiPdfBrowserInit(fileInput) {
  var id = _pdfBrowserFileId_(fileInput);
  if (!id) throw new Error('Please enter a Drive file ID or link.');
  var file;
  try { file = DriveApp.getFileById(id); }
  catch (err) { throw new Error('This file cannot be opened with your account (' + (err && err.message || err) + ').'); }
  if (file.getMimeType() !== 'application/pdf') throw new Error('This file is not a PDF.');
  var labels = {};
  ['grammar', 'terminology', 'style', 'prompt'].forEach(function(t) { labels['type.' + t] = _ct_('type.' + t); });
  return { fileId: id, name: file.getName(), size: file.getSize(), token: ScriptApp.getOAuthToken(), labels: labels };
}

// ─── PRÜFUNG MIT GEMINI ────────────────────────────────────────────────────
// Der Browser zerlegt die PDF in Pakete (wie _drivePdfPrepUnit_) und schickt sie
// einzeln hierher; hier laufen Prompt, Regeln und Gemini-Anfrage wie im
// Drive-Add-on (_drivePdfPrompt_, _drivePdfRunBatch_). Es wird nichts gespeichert:
// jeder Aufruf ist unabhängig, der Browser hält den Stand.

/**
 * Vorbereitung: Datei prüfen, Token geben, Sprache und Regeln laden.
 * Liefert zusätzlich docPromptTitles: Gesamtdokument-Prompts, die im Browser-Weg
 * noch nicht laufen (der Browser zeigt dazu einen Hinweis).
 */
function apiPdfBrowserPrepare(fileInput, language) {
  var lang = DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === language; }) ? language : 'de';
  var info = apiPdfBrowserInit(fileInput);
  _driveGeminiConfig_(); // bricht früh ab, wenn kein API-Key konfiguriert ist
  try { PropertiesService.getUserProperties().setProperty(DRIVE_PDF_LAST_LANG_KEY, lang); } catch (propErr) {}
  var rules = _rulesLanguageSupported_(lang) ? apiGetRulesConfig(lang) : [];
  var docPrompts = _docPromptsFromRules_(rules.filter(function(r) { return r.IsEnabled; }));
  info.language = lang;
  info.languageName = _drivePdfLanguageName_(lang);
  info.docPromptTitles = docPrompts.map(function(dp) { return dp.title; });
  try { info.docNotes = _docPromptNotes_(lang, rules); } catch (noteErr) { info.docNotes = []; }
  info.maxBytes = DRIVE_PDF_MAX_BYTES;
  return info;
}

// Der Prompt hängt nur von Sprache und Hinweis auf entfernte Bilder ab und wird
// für alle Pakete eines Laufs gebraucht: kurz zwischenspeichern, statt ihn für
// jedes Paket (parallel) neu aus Regeln und Glossar zu bauen.
function _pdfBrowserPrompt_(language, imagesRemoved) {
  var key = 'pdfbrowser.prompt.' + language + '.' + (imagesRemoved ? 1 : 0);
  var cache = null;
  try { cache = CacheService.getUserCache(); var hit = cache.get(key); if (hit) return hit; } catch (cacheErr) { cache = null; }
  var prompt = _drivePdfPrompt_({ language: language, imagesRemoved: imagesRemoved });
  try { if (cache && prompt.length < 90000) cache.put(key, prompt, 300); } catch (putErr) {}
  return prompt;
}

/**
 * Prüft ein Paket (PDF als Base64, Seiten from..to der Originaldatei, ab 0).
 * meta: { language, from, to, split, imagesRemoved }. Liefert { issues } oder
 * { failed: true, error } - der Browser wiederholt dann bzw. zerlegt das Paket.
 */
function apiPdfBrowserCheckPart(b64, meta) {
  meta = meta || {};
  var lang = DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === meta.language; }) ? meta.language : 'de';
  var from = Math.max(0, parseInt(meta.from, 10) || 0);
  var to = Math.max(from + 1, parseInt(meta.to, 10) || from + 1);
  if (!b64 || typeof b64 !== 'string') throw new Error('No PDF data.');
  var cfg = _driveGeminiConfig_();
  var prompt = _pdfBrowserPrompt_(lang, !!meta.imagesRemoved);
  var bytes = Utilities.base64Decode(b64);
  var res;
  try {
    res = _drivePdfRunBatch_(cfg, prompt, [{ from: from, to: to, bytes: bytes }], !!meta.split);
  } catch (err) {
    return { failed: true, error: String(err && err.message || err) };
  }
  if (res.failedRanges.length) return { failed: true, error: 'AI request failed' };
  return { issues: res.issues };
}

// Beim Weiterreichen an Apps-Script-Funktionen nur bekannte Felder und begrenzte Längen.
function _pdfBrowserCleanIssues_(issues) {
  return (Array.isArray(issues) ? issues : []).slice(0, PDF_ANNOT_MAX_PER_PDF * 5).map(function(i) {
    var cut = function(v, n) { return String(v === undefined || v === null ? '' : v).slice(0, n); };
    return { type: cut(i.type, 20), rule: cut(i.rule, 200), location: cut(i.location, 200), original: cut(i.original, 2000),
             suggestion: cut(i.suggestion, 2000), explanation: cut(i.explanation, 4000) };
  });
}

/** Ergebnis als Google Sheet (wie "Export as Sheet" im Add-on). Liefert die Adresse. */
function apiPdfBrowserExportSheet(issues, fileName, language) {
  var lang = DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === language; }) ? language : 'de';
  return _buildDrivePdfReportSheet_(_pdfBrowserCleanIssues_(issues), String(fileName || 'PDF'), lang);
}

/** Protokolleintrag für einen abgeschlossenen Lauf (wie DRIVE_PDF_CHECK_RUN im Add-on). */
function apiPdfBrowserLogRun(fileName, issueCount, partCount, failedRanges) {
  var failed = (Array.isArray(failedRanges) ? failedRanges : []).slice(0, 50).map(function(r) { return String(r).slice(0, 20); });
  logAuditEvent_(getUserEmail_(), 'DRIVE_PDF_CHECK_RUN', String(fileName || 'PDF').slice(0, 200) + ' - ' + (parseInt(issueCount, 10) || 0) +
    ' issue(s), ' + (parseInt(partCount, 10) || 0) + ' part(s), browser' + (failed.length ? ', failed pages ' + failed.join(',') : ''));
}

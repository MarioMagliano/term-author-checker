// ============================================================================
// PDF IM BROWSER: Server-Seite
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
// Aufruf: <Web-App-URL>?page=pdfbrowser[&fileId=...][&lang=de][&start=1][&debug=1]
// start=1 (vom Drive-Add-on gesetzt) startet die Pruefung sofort, debug=1 blendet die Diagnose ein.
// ============================================================================

// Aus doGet (Code.js): Seite fuer ?page=pdfbrowser ausliefern.
function _renderPdfBrowserPage_(e) {
  var p = (e && e.parameter) || {};
  var tpl = HtmlService.createTemplateFromFile('PdfBrowser');
  tpl.fileId = String(p.fileId || '');
  tpl.autoStart = String(p.start || '') === '1' && !!_pdfBrowserFileId_(p.fileId);
  tpl.debug = String(p.debug || '') === '1';
  tpl.languages = DRIVE_PDF_LANGUAGES;
  // Wie viele Pakete gleichzeitig an Gemini gehen (mehr = schneller, aber eher Limits des Proxys).
  tpl.parallel = Math.max(1, Math.min(12, parseInt(p.parallel, 10) || 6));
  var wanted = String(p.lang || '');
  var last = '';
  try { last = PropertiesService.getUserProperties().getProperty(DRIVE_PDF_LAST_LANG_KEY) || ''; } catch (propErr) {}
  var known = function(code) { return DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === code; }); };
  tpl.lastLang = known(wanted) ? wanted : (known(last) ? last : 'de');
  return tpl.evaluate()
    .setTitle('Kärcher TermCheck – PDF check')
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
  ['ann.severity', 'ann.evidence'].forEach(function(k) { labels[k] = _ct_(k); }); // Beschriftung der Kommentare in der PDF
  return { fileId: id, name: file.getName(), size: file.getSize(), token: ScriptApp.getOAuthToken(), labels: labels };
}

// ─── PRÜFUNG MIT GEMINI ────────────────────────────────────────────────────
// Der Browser zerlegt die PDF in Pakete (wie _drivePdfPrepUnit_) und schickt sie
// einzeln hierher; hier laufen Prompt, Regeln und Gemini-Anfrage wie im
// Drive-Add-on (_drivePdfPrompt_, _drivePdfRunBatch_). Es wird nichts gespeichert:
// jeder Aufruf ist unabhängig, der Browser hält den Stand.

/**
 * Vorbereitung: Datei prüfen, Token geben, Sprache und Regeln laden.
 * Liefert zusätzlich docPromptTitles (die aktiven Gesamtdokument-Prompts, z. B. Gems)
 * und docMaxBytes (so groß darf die PDF für diese Prompts höchstens sein, sonst läuft
 * der Seitentext).
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
  // Aktive Gesamtdokument-Prompts ueber der Grenze laufen nicht; die Seite sagt das, statt sie still wegzulassen.
  info.docPromptMax = _docPromptMax_();
  info.docPromptsSkipped = rules.filter(function(r) { return r.IsEnabled && _isDocScopePrompt_(r); })
    .slice(info.docPromptMax).map(function(r) { return String(r.Description || r.Name || 'Prompt'); });
  info.maxBytes = DRIVE_PDF_MAX_BYTES;
  info.docMaxBytes = _docPromptPdfMaxBytes_();
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
  // Synonyme/Homonyme: freigegebene Begriffe zu den Fachbegriffen dieser Seiten (TermSynonyms.js).
  // Faellt das aus, wird das Paket wie bisher geprueft.
  try {
    var termBlock = _synContextForPdfPart_(cfg, lang, b64);
    if (termBlock) prompt += '\n\nTERMINOLOGY FOR THESE PAGES (use it for check type 2):\n' + termBlock;
  } catch (synErr) { Logger.log('apiPdfBrowserCheckPart: Synonym-Suche uebersprungen: ' + synErr); }
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

/**
 * Gesamtdokument-Prompts (z. B. Gems): je Prompt eine Anfrage über das ganze Dokument
 * (wie _drivePdfDocStep_ im Add-on). req: { language, fileName, pages, sizeBytes,
 * mode: 'pdf' | 'text', b64 (PDF) | texts (Text je Seite), indexes (Auswahl, Standard alle) }.
 * Liefert { indexes, reports }: je Prompt { title, markdown, issues, truncated, note }
 * oder { title, error, code }. Fehlgeschlagene Prompts wiederholt der Browser im Textmodus.
 */
function apiPdfBrowserDocPrompts(req) {
  req = req || {};
  var lang = DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === req.language; }) ? req.language : 'de';
  var cfg = _driveGeminiConfig_();
  var rules = _rulesLanguageSupported_(lang) ? apiGetRulesConfig(lang) : [];
  var all = _docPromptsFromRules_(rules.filter(function(r) { return r.IsEnabled; }));
  var indexes = (Array.isArray(req.indexes) ? req.indexes : all.map(function(p, i) { return i; }))
    .map(function(i) { return parseInt(i, 10); })
    .filter(function(i, k, arr) { return i >= 0 && i < all.length && arr.indexOf(i) === k; });
  if (!indexes.length) return { indexes: [], reports: [] };
  var selected = indexes.map(function(i) { return all[i]; });
  var fileName = String(req.fileName || 'PDF').slice(0, 200);
  var pages = Math.max(0, Math.min(100000, parseInt(req.pages, 10) || 0));
  var sizeBytes = Math.max(0, parseInt(req.sizeBytes, 10) || 0);

  var reports;
  if (req.mode === 'pdf') {
    if (!req.b64 || typeof req.b64 !== 'string') throw new Error('No PDF data.');
    reports = _runDocPrompts_(cfg, selected, { fileName: fileName, pages: pages, isPdf: true }, Utilities.base64Decode(req.b64));
  } else {
    var texts = (Array.isArray(req.texts) ? req.texts : []).map(function(t) { return String(t === undefined || t === null ? '' : t); });
    var total = texts.length || pages;
    var chars = texts.join('').replace(/\s+/g, '').length;
    if (chars < 200) {
      var msg = _ct_('d.docNoText', { mb: _driveMb_(sizeBytes) });
      reports = selected.map(function(dp) { return { title: dp.title, error: msg }; });
    } else {
      var text = texts.map(function(t, i) { return '=== Page ' + (i + 1) + ' of ' + total + ' ===\n' + t; }).join('\n\n');
      var note = _ct_('d.docTextMode', { mb: _driveMb_(sizeBytes), pages: total });
      logAuditEvent_(getUserEmail_(), 'DOC_PROMPT_TEXT_MODE', fileName + ' - ' + _driveMb_(sizeBytes) + ' MB, ' + total + ' pages, ' + text.length + ' chars, browser');
      reports = _runDocPrompts_(cfg, selected, { fileName: fileName, pages: total, isPdf: false, fromPdf: true, text: text }, null)
        .map(function(r) { if (!r.error) r.note = note; return r; });
    }
  }
  return { indexes: indexes, reports: reports };
}

/**
 * Bericht der Gesamtdokument-Prompts als Google Doc (wie im Add-on): Titel wie das geprüfte
 * Dokument, Zusammenfassung, Checkliste nach Schwere, umfassende Erklärung. reports: die Berichte
 * aus apiPdfBrowserDocPrompts (mit ihren Funden), meta: { language, pages, mode, pageChecks }.
 * Liefert { url, items, error }.
 */
function apiPdfBrowserDocReport(fileName, reports, meta) {
  var cut = function(v, n) { return String(v === undefined || v === null ? '' : v).slice(0, n); };
  var clean = (Array.isArray(reports) ? reports : []).slice(0, 20).map(function(r) {
    return {
      title: cut(r && r.title, 200), markdown: cut(r && r.markdown, 400000), error: cut(r && r.error, 500),
      note: cut(r && r.note, 400), truncated: !!(r && r.truncated),
      issues: (r && Array.isArray(r.issues) ? r.issues : []).slice(0, 300).map(function(i) {
        return { type: 'prompt', rule: cut(i.rule, 200), location: cut(i.location, 200), original: cut(i.original, 2000),
                 suggestion: cut(i.suggestion, 2000), explanation: cut(i.explanation, 4000),
                 severity: _docSeverity_(i.severity, i.explanation), evidence: cut(i.evidence, 2000) };
      })
    };
  });
  meta = meta || {};
  var safeMeta = {
    language: DRIVE_PDF_LANGUAGES.some(function(pair) { return pair[0] === meta.language; }) ? meta.language : 'de',
    pages: Math.max(0, Math.min(100000, parseInt(meta.pages, 10) || 0)),
    mode: ['pdf', 'text', 'mixed'].indexOf(meta.mode) !== -1 ? meta.mode : '',
    pageChecks: (Array.isArray(meta.pageChecks) ? meta.pageChecks : []).slice(0, 12).map(function(p) {
      return { label: cut(p && p.label, 60), n: Math.max(0, parseInt(p && p.n, 10) || 0) };
    })
  };
  return _finishDocPromptReports_(cut(fileName, 200) || 'PDF', clean, 'pdfs', [], safeMeta);
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

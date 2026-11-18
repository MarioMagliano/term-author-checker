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

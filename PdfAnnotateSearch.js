// ============================================================================
// PDF: FUNDSTELLEN SUCHEN UND ANNOTATIONEN ZUSAMMENSTELLEN (reine Funktionen)
// ----------------------------------------------------------------------------
// Diese Datei enthaelt nur Funktionen ohne Apps-Script-Dienste (kein DriveApp,
// UrlFetchApp, Utilities ...). Sie laeuft deshalb unveraendert an zwei Stellen:
//  - in Apps Script (Drive-Add-on, DriveAddon.js) und
//  - im Browser (Web Worker, gebaut aus PdfInflate, PdfTextPosition,
//    PdfAnnotate, PdfShrink und dieser Datei, siehe tools/build-pdf-worker.cjs).
// Wer hier etwas aendert, muss danach "node tools/build-pdf-worker.cjs"
// ausfuehren (erzeugt PdfWorkerSource.html).
// ============================================================================

// So viele Seitenmodelle (Glyphen mit Position) bleiben gleichzeitig im Speicher.
var PDF_ANNOT_MODEL_CACHE_PAGES = 8;

/**
 * Sucht jeden Fund im Seitentext (PdfTextPosition.gs) und baut daraus die
 * Annotationen pro Seite. doc/pages: siehe _pdfOpenDoc_ / _pdfCollectPages_.
 * Liefert { pageAnnotations, count, positioned }.
 */
// deadline (ms seit 1970, optional): danach wird ein Fund nur noch auf der
// von Gemini genannten Seite gesucht statt in allen Seiten - jeder Fund
// bekommt trotzdem seine Notiz (notfalls oben links auf dieser Seite).
//
// opts (optional) macht die Suche fortsetzbar:
//   stopAt: Zeitpunkt (ms seit 1970), ab dem die Suche unterbricht. Sie liefert
//           dann { done: false, state } - state ist reines JSON.
//   resume: state eines früheren Aufrufs; die Suche macht dort weiter.
// Ohne Unterbrechung enthält das Ergebnis done: true.
function _drivePdfComputeAnnotations_(doc, pages, issues, deadline, opts) {
  opts = opts || {};
  var st = opts.resume || { next: 0, pageAnnotations: {}, occurrenceUsed: {}, positioned: 0, pageWs: {} };
  var STOP = {};
  var builtThisRun = 0;

  // Speicher: das volle Seitenmodell (alle Glyphen mit Position) wird nur für
  // die zuletzt benutzten Seiten gehalten. Für die Suche über alle Seiten
  // bleibt pro Seite nur der normalisierte Text (pageIndex) - sonst läge bei
  // langen Dokumenten das ganze Dokument als Glyphen im Speicher.
  var modelCache = {}, modelOrder = [];
  var pageIndex = {}; // pageIdx -> { ws, strip } oder null (Seite nicht auswertbar)
  for (var wk in st.pageWs) {
    if (st.pageWs.hasOwnProperty(wk)) pageIndex[wk] = st.pageWs[wk] === null ? null : _pdfSearchIndexFromWs_(st.pageWs[wk]);
  }
  // Liefert das Modell, null (Seite nicht auswertbar) oder STOP (Zeit um).
  function getPageModel(pageIdx) {
    if (modelCache.hasOwnProperty(pageIdx)) return modelCache[pageIdx];
    if (pageIndex[pageIdx] === null) return null;
    // Mindestens eine Seite pro Aufruf, damit es immer vorangeht.
    if (opts.stopAt && builtThisRun > 0 && Date.now() > opts.stopAt) return STOP;
    builtThisRun++;
    var model = null;
    try {
      var glyphs = _pdfExtractPageGlyphs_(doc, pages[pageIdx]);
      if (glyphs && glyphs.length) model = _pdfBuildPageModel_(glyphs);
    } catch (e) {
      Logger.log('_drivePdfComputeAnnotations_: Seite ' + pageIdx + ' - Content-Stream nicht auswertbar: ' + e.message);
    }
    if (!pageIndex.hasOwnProperty(pageIdx)) {
      pageIndex[pageIdx] = model ? _pdfPageSearchIndex_(model) : null;
      st.pageWs[pageIdx] = model ? pageIndex[pageIdx].ws : null;
    }
    if (!model) return null;
    modelCache[pageIdx] = model;
    modelOrder.push(pageIdx);
    if (modelOrder.length > PDF_ANNOT_MODEL_CACHE_PAGES) delete modelCache[modelOrder.shift()];
    return model;
  }
  // Liefert den Suchindex, null oder STOP.
  function getPageIndex(pageIdx) {
    if (!pageIndex.hasOwnProperty(pageIdx) && getPageModel(pageIdx) === STOP) return STOP;
    return pageIndex[pageIdx];
  }

  var capped = issues.slice(0, PDF_ANNOT_MAX_PER_PDF);
  var pageAnnotations = st.pageAnnotations;
  var occurrenceUsed = st.occurrenceUsed;  // gleiches Zitat mehrfach gemeldet -> nächstes Vorkommen nehmen

  // Sucht die Stelle eines Fundes: { page, hit, model } oder STOP. Ändert bis
  // zum Treffer nichts am Zwischenstand, ein Abbruch kostet also nur diesen Fund.
  function locate(issue, guessedPage) {
    // Erst die von Gemini genannte Seite versuchen, danach alle anderen -
    // der tatsächliche Textinhalt ist zuverlässiger als Geminis Seitenangabe.
    // Durchgang 1 nimmt nur Seiten, auf denen das Zitat wörtlich steht;
    // Durchgang 2 lässt auch unscharfe Treffer (nur der Zitatanfang) zu.
    var searchOrder = [guessedPage];
    if (!deadline || Date.now() < deadline) {
      for (var p = 0; p < pages.length; p++) { if (p !== guessedPage) searchOrder.push(p); }
    }
    var needles = issue.original ? _pdfQuoteNeedles_(issue.original) : [];
    var kinds = [];
    for (var pass = 2; pass >= 1 && needles.length; pass--) {
      for (var si = 0; si < searchOrder.length; si++) {
        if (pass === 2) {
          var index = getPageIndex(searchOrder[si]);
          if (index === STOP) return STOP;
          kinds[si] = index ? _pdfQuoteMatchKind_(index, needles) : 0;
        }
        if (kinds[si] !== pass) continue;
        var model = getPageModel(searchOrder[si]);
        if (model === STOP) return STOP;
        if (!model) continue;
        var occKey = searchOrder[si] + '|' + String(issue.original).toLowerCase();
        var h = _pdfFindQuoteOnPage_(model, issue.original, occurrenceUsed[occKey] || 0);
        if (h) {
          occurrenceUsed[occKey] = (occurrenceUsed[occKey] || 0) + 1;
          return { page: searchOrder[si], hit: h, model: model };
        }
      }
    }
    return { page: null, hit: null, model: null };
  }

  for (; st.next < capped.length; st.next++) {
    var issue = capped[st.next];
    var guessedPage = _pdfGuessPageIndex_(issue.location);
    if (guessedPage === null || guessedPage < 0 || guessedPage >= pages.length) guessedPage = 0;

    var found = locate(issue, guessedPage);
    if (found === STOP) return { done: false, state: st, count: capped.length, total: issues.length };
    var pageIdx = found.page !== null ? found.page : guessedPage;

    var type = _issueTypeKey_(issue);
    var typeLabel = (type === 'prompt' && issue.rule ? issue.rule : _ct_('type.' + type)).toUpperCase();
    var contents = '[' + typeLabel + ']\n' + issue.original + '\n\n-> ' + issue.suggestion +
      (issue.explanation ? '\n\n' + issue.explanation : '') +
      (issue.evidence ? '\n\n' + _ct_('ann.evidence') + ': ' + issue.evidence : '') +
      (issue.severity ? '\n\n' + _ct_('ann.severity') + ': ' + issue.severity : '') +
      (issue.location ? '\n\n(AI-reported location: ' + issue.location + ')' : '');
    var ann = { contents: contents, title: 'Author Check (' + typeLabel + ')' };

    if (found.hit) {
      st.positioned++;
      ann.highlight = found.hit.boxes;
    } // sonst: keine Markierung -> Notiz oben links auf der Seite (pdfAnnotationUpdate_)

    if (!pageAnnotations[pageIdx]) pageAnnotations[pageIdx] = [];
    pageAnnotations[pageIdx].push(ann);
  }

  return { done: true, pageAnnotations: pageAnnotations, count: capped.length, total: issues.length, positioned: st.positioned };
}

/**
 * Liest Struktur und Seiten einer PDF über reader (ohne Bilder). Fehler dabei
 * sind mit err.pdfStructure markiert.
 */
function _driveAnnotatedAnalyze_(reader) {
  try {
    return _driveAnnotatedOpen_(pdfRebuild_(reader, { imageBudget: 0 }));
  } catch (err) {
    throw _driveAnnotatedStructureError_(err);
  }
}

/** Aus dem Modell der neu aufgebauten PDF: Dokument-Zugriff und Seiten. */
function _driveAnnotatedOpen_(model) {
  var doc = _pdfOpenDoc_(model.text, model.offsets);
  var pages = _pdfCollectPages_(model.text, model.offsets, model.rootNum, doc);
  return { model: model, doc: doc, pages: pages };
}

/** Markiert Fehler der PDF-Struktur (im Gegensatz zu Lesefehlern von Drive). */
function _driveAnnotatedStructureError_(err) {
  if (!/^Drive download/.test(err.message || '')) err.pdfStructure = true;
  return err;
}

function _driveAnnotatedRequirePlain_(an) {
  // Verschlüsselt: gleich abbrechen statt erst nach der ganzen Suche (pdfAnnotationUpdate_).
  if (an.model.encrypted) throw new Error('Encrypted PDFs are not supported for annotation.');
}

/** Baut den Anhang (Incremental Update) für die Original-Datei hinter reader. */
function _driveAnnotatedAppendix_(reader, an, pageAnnotations) {
  return pdfAnnotationUpdate_({
    baseLength: reader.size,
    endsWithNewline: reader.read(reader.size - 1, reader.size) === '\n',
    prevXref: an.model.origStartxref,
    trailerDict: an.model.origTrailer,
    rootNum: an.model.rootNum,
    pages: an.pages,
    maxObjNum: an.model.maxNum,
    readAnnotsArray: function(num) { return _pdfReadArrayObject_(an.model.text, an.model.offsets, num, an.doc); }
  }, pageAnnotations);
}

// Anzeige-Kategorie eines Fundes: terminology, grammar, prompt (Gesamtdokument-
// Prompt) oder style (alles andere).
function _issueTypeKey_(issue) {
  var t = issue && issue.type;
  return (t === 'terminology' || t === 'grammar' || t === 'prompt') ? t : 'style';
}

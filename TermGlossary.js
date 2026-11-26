// ============================================================================
// TERMBASE-GLOSSAR FUER DEN AUTHOR CHECK
// ----------------------------------------------------------------------------
// Baut aus den Phrase-Termbases eine Liste "verbotener Begriff -> richtiger
// Begriff" und gleicht sie mit dem Dokumenttext ab.
//
// Frueher (Authorcheck.js) galt:
//  - nur die ersten 20 Seiten je Termbase (= 1000 Konzepte) wurden gelesen,
//  - dann wurde die Liste still auf 400 Eintraege gekuerzt,
//  - die Sprache musste exakt "de" heissen ("de_DE", "DE" passten nie),
//  - bei Synonymen zaehlte nur der erste erlaubte Begriff, bei Homonymen (dasselbe
//    Wort in mehreren Konzepten) blieb nur das erste Konzept,
//  - und nur die KI sollte die Begriffe im Text finden - bei langen Dokumenten
//    sah sie davon nur die ersten 60.000 Zeichen und von der Liste nur einen Teil.
//
// Jetzt:
//  - alle Seiten, in Paketen parallel und fortsetzbar (Fortschritt im Cache),
//  - mehrere erlaubte Begriffe (Synonyme) bleiben alle erhalten, der als
//    "preferred" markierte zuerst,
//  - derselbe verbotene Begriff in mehreren Konzepten wird zu einem Eintrag mit
//    allen richtigen Begriffen (Homonym, "hängt von der Bedeutung ab"),
//  - der Abgleich mit dem Text laeuft ohne KI ueber das GANZE Dokument; die KI
//    bekommt je Textabschnitt nur die Eintraege, die dort vorkommen.
// ============================================================================

var GLOSSARY_CACHE_PREFIX = 'AC_GLOSSARY_V2_';
var GLOSSARY_TTL = 21600;               // 6 h
var GLOSSARY_PAGE_SIZE = 50;
var GLOSSARY_MAX_PAGES_PER_TB = 400;    // Sicherung: 20.000 Konzepte je Termbase
var GLOSSARY_BATCH = 8;                 // parallele Anfragen an Phrase
var GLOSSARY_BUILD_BUDGET_MS = 150000;  // danach Teilergebnis, der naechste Lauf macht weiter
var GLOSSARY_PROMPT_MAX = 1500;         // Eintraege, die höchstens in einen Prompt gehen
var GLOSSARY_MAX_TERM_ISSUES = 300;     // verschiedene Fundstellen je Pruefung
// Endungen, die hinter einem Begriff erlaubt sind (Plural, Genitiv, Dativ ...):
// "Sauger" findet auch "Saugers", "Saugern".
var GLOSSARY_SUFFIX_RE = '(?:ern|en|er|es|e|n|s)?';

// "de", "DE", "de_DE", "de-DE" -> "de"; Vergleich nur ueber die Hauptsprache.
function _glossaryLangBase_(code) {
  return String(code || '').toLowerCase().replace('-', '_').split('_')[0];
}

function _glossaryTermText_(t) {
  return String(t.text || t.term || t.value || '').trim();
}

// Ein Konzept (Antwort von /browse) -> Eintraege [{wrong, correct:[...], cs}].
// Nur Konzepte, die in der Sprache sowohl einen verbotenen als auch einen
// erlaubten Begriff haben.
function _glossaryEntriesFromConcept_(concept, lang) {
  var all = [];
  ((concept && concept.terms) || []).forEach(function (ti) {
    (Array.isArray(ti) ? ti : [ti]).forEach(function (t) { if (t && typeof t === 'object') all.push(t); });
  });
  var want = _glossaryLangBase_(lang);
  var same = all.filter(function (t) { return _glossaryLangBase_(t.lang || t.language || '') === want; });
  var forbidden = same.filter(function (t) { return t.forbidden === true; });
  var allowed = same.filter(function (t) { return t.forbidden !== true && _glossaryTermText_(t); });
  if (!forbidden.length || !allowed.length) return [];

  // Ist ein Begriff als "preferred" markiert, ist das der richtige; sonst gelten
  // alle erlaubten Begriffe (Synonyme) als richtig.
  var preferred = allowed.filter(function (t) { return t.preferred === true; });
  var correct = [], seen = {};
  (preferred.length ? preferred : allowed).forEach(function (t) {
    var txt = _glossaryTermText_(t), k = txt.toLowerCase();
    if (!seen[k]) { seen[k] = true; correct.push(txt); }
  });
  var allowedLower = {};
  allowed.forEach(function (t) { allowedLower[_glossaryTermText_(t).toLowerCase()] = true; });

  var out = [];
  forbidden.forEach(function (f) {
    var wrong = _glossaryTermText_(f);
    // Dasselbe Wort verboten und erlaubt im selben Konzept: Datenfehler, nicht melden.
    if (!wrong || allowedLower[wrong.toLowerCase()]) return;
    out.push({ wrong: wrong, correct: correct.slice(), cs: f.caseSensitive === true });
  });
  return out;
}

// Rohe Eintraege (aus allen Termbases/Konzepten) zusammenfuehren: ein Eintrag je
// verbotenem Begriff. Kommt er in mehreren Konzepten vor (Homonym), werden die
// richtigen Begriffe vereinigt und multi = true gesetzt.
function _glossaryMerge_(raw) {
  var byKey = {}, order = [];
  (raw || []).forEach(function (e) {
    var k = e.wrong.toLowerCase().replace(/\s+/g, ' ');
    var cur = byKey[k];
    if (!cur) {
      cur = byKey[k] = { wrong: e.wrong, correct: [], cs: false, concepts: 0, multi: false };
      order.push(k);
    }
    cur.concepts++;
    if (e.cs) cur.cs = true;
    e.correct.forEach(function (c) {
      var low = c.toLowerCase();
      if (!cur.correct.some(function (x) { return x.toLowerCase() === low; })) cur.correct.push(c);
    });
  });
  return order.map(function (k) { var e = byKey[k]; e.multi = e.concepts > 1; return e; });
}

function _glossaryLine_(e) {
  return '- ' + e.wrong + ' → ' + e.correct.join(' / ') + (e.multi ? ' (depends on the meaning)' : '');
}

// Eintraege, deren verbotener Begriff (als Teilstring, ohne Beugung) im Text steht.
// Dient dazu, der KI nur Passendes zu zeigen.
function _glossaryForText_(glossary, text) {
  var lower = String(text || '').toLowerCase();
  return (glossary || []).filter(function (e) { return lower.indexOf(e.wrong.toLowerCase().replace(/\s+/g, ' ').split(' ')[0]) !== -1; });
}

function _glossaryEscapeRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _glossaryRegex_(e) {
  var src = e.wrong.trim().split(/\s+/).map(_glossaryEscapeRe_).join('\\s+');
  return new RegExp('(?<![\\p{L}\\p{N}])(' + src + ')(' + GLOSSARY_SUFFIX_RE + ')(?![\\p{L}\\p{N}])', e.cs ? 'gu' : 'giu');
}

// Liegt die Fundstelle mitten in einem richtigen Begriff, der den falschen enthaelt
// (z. B. falsch "Sauger", richtig "Nass-Sauger")? Dann ist es kein Fehler.
function _glossaryInsideCorrect_(text, e, index, matchLen) {
  var wrongLow = e.wrong.toLowerCase();
  for (var i = 0; i < e.correct.length; i++) {
    var c = e.correct[i].toLowerCase();
    var off = c.indexOf(wrongLow);
    if (off === -1 || c.length <= wrongLow.length) continue;
    var start = index - off;
    if (start >= 0 && text.substr(start, c.length).toLowerCase() === c) return true;
  }
  return false;
}

// Gleicht das Glossar ohne KI mit dem ganzen Text ab. Liefert Funde im Format der
// Author-Check-Liste. msg(key, vars): Texte in der Oberflaechensprache.
function _glossaryFindIssues_(glossary, text, msg) {
  text = String(text || '');
  var lower = text.toLowerCase();
  var issues = [];
  (glossary || []).forEach(function (e) {
    if (issues.length >= GLOSSARY_MAX_TERM_ISSUES) return;
    if (lower.indexOf(e.wrong.toLowerCase().replace(/\s+/g, ' ').split(' ')[0]) === -1) return;
    var re = _glossaryRegex_(e), m, forms = {}, order = [];
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (_glossaryInsideCorrect_(text, e, m.index, m[0].length)) continue;
      var surface = m[1] + m[2];
      if (!forms[surface]) { forms[surface] = { count: 0, suffix: m[2] }; order.push(surface); }
      forms[surface].count++;
    }
    order.forEach(function (surface) {
      if (issues.length >= GLOSSARY_MAX_TERM_ISSUES) return;
      var f = forms[surface];
      var suggestion = e.correct.length === 1 ? e.correct[0] + f.suffix : e.correct.join(' / ');
      var explanation = msg(e.multi ? 'c.termForbiddenMulti' : 'c.termForbidden', { wrong: e.wrong, correct: e.correct.join(' / ') }) +
        (f.count > 1 ? ' ' + msg('c.termCount', { n: f.count }) : '');
      issues.push({ type: 'terminology', original: surface, suggestion: suggestion, explanation: explanation, source: 'termbase' });
    });
  });
  return issues;
}

// ─── GLOSSAR AUS PHRASE LESEN ───────────────────────────────────────────────
// Liest eine Termbase seitenweise; der Stand (naechste Seite, bisherige Eintraege)
// liegt im Cache, damit ein Lauf, der das Zeitbudget ausschoepft, beim naechsten
// Mal dort weitermacht statt von vorn.
function _glossaryReadTermbase_(tb, lang, auth, deadline) {
  var cache = CacheService.getScriptCache();
  var key = GLOSSARY_CACHE_PREFIX + tb.uid + '_' + _glossaryLangBase_(lang);
  var state = _cacheGetCompressed_(cache, key) || { n: 0, e: [], done: false };
  if (state.done) return state;

  function request(page) {
    return {
      url: PHRASE_V1 + '/termBases/' + encodeURIComponent(tb.uid) + '/browse',
      method: 'post', contentType: 'application/json', headers: { Authorization: auth },
      payload: JSON.stringify({ pageNumber: page, pageSize: GLOSSARY_PAGE_SIZE, queryLang: lang }),
      muteHttpExceptions: true
    };
  }
  function retryable(code) { return code === 429 || code >= 500; }

  // Liest eine Antwort; true = weiterlesen, false = Ende dieser Termbase erreicht.
  function take(res, page) {
    var data;
    try { data = JSON.parse(res.getContentText()); } catch (e) { state.done = true; return false; }
    var concepts = data.searchResults || data.concepts || [];
    concepts.forEach(function (c) {
      _glossaryEntriesFromConcept_(c, lang).forEach(function (en) { state.e.push([en.wrong, en.correct, en.cs ? 1 : 0]); });
    });
    state.n = page + 1;
    if (typeof data.totalPages === 'number' && state.n >= data.totalPages) { state.done = true; return false; }
    if (concepts.length < GLOSSARY_PAGE_SIZE) { state.done = true; return false; }
    return true;
  }

  var go = true;
  while (go && !state.done && state.n < GLOSSARY_MAX_PAGES_PER_TB && Date.now() < deadline) {
    var pages = [];
    for (var i = 0; i < GLOSSARY_BATCH && state.n + i < GLOSSARY_MAX_PAGES_PER_TB; i++) pages.push(state.n + i);
    var responses;
    try { responses = UrlFetchApp.fetchAll(pages.map(request)); } catch (e) { break; }
    for (var j = 0; j < pages.length && go; j++) {
      var res = responses[j], code = res.getResponseCode();
      if (retryable(code)) {
        Utilities.sleep(1000);
        try { res = UrlFetchApp.fetch(request(pages[j]).url, request(pages[j])); code = res.getResponseCode(); } catch (e) { code = 599; }
      }
      if (code === 200) go = take(res, pages[j]);
      else if (retryable(code)) go = false;                      // spaeter fortsetzen
      else { state.done = true; go = false; }                    // z. B. Seite hinter dem Ende
    }
  }
  if (state.n >= GLOSSARY_MAX_PAGES_PER_TB) state.done = true;
  _cachePutCompressed_(cache, key, state, GLOSSARY_TTL);
  return state;
}

// Liefert { entries: [...], partial: <true, wenn nicht alle Termbases fertig gelesen wurden> }.
function _buildTerminologyGlossaryInfo_(sourceLang) {
  var lang = String(sourceLang || 'de').trim();
  var termbases = _getTargetTermbases_();
  var auth = _phraseAuth_();
  var deadline = Date.now() + GLOSSARY_BUILD_BUDGET_MS;
  var raw = [], partial = false;

  termbases.forEach(function (tb) {
    var state;
    try { state = _glossaryReadTermbase_(tb, lang, auth, deadline); }
    catch (e) { Logger.log('Glossar: Termbase ' + tb.name + ' nicht gelesen: ' + e); partial = true; return; }
    if (!state.done) partial = true;
    state.e.forEach(function (r) { raw.push({ wrong: r[0], correct: r[1], cs: r[2] === 1 }); });
  });
  return { entries: _glossaryMerge_(raw), partial: partial };
}

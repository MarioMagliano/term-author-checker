// ============================================================================
// SYNONYME UND HOMONYME ANHAND DER FREIGEGEBENEN TERMBASE-BEGRIFFE (KI)
// ----------------------------------------------------------------------------
// In der Termbase stehen nur freigegebene Begriffe, keine verbotenen. Ein Wort wie
// "Schrubbkopf" (richtig: "Bürstenkopf") steht dort nirgends und laesst sich deshalb
// nicht ueber eine Liste "falsch -> richtig" finden. Stattdessen:
//
//  1. Gemini nennt je Textabschnitt die Fachbegriffe des Textes und moegliche
//     Alternativnamen (Synonyme), die als offizieller Begriff in Frage kommen.
//  2. Diese Woerter werden in den Termbases nachgeschlagen (wie bei der AI-Suche).
//  3. Der Pruef-Prompt bekommt je Abschnitt die gefundenen freigegebenen Begriffe samt
//     Bedeutung und Anweisung: Woerter melden, die dasselbe meinen, aber nicht
//     freigegeben sind (Synonym), und freigegebene Begriffe in anderer Bedeutung
//     (Homonym).
//
// Faellt ein Schritt aus (Phrase, Gemini, Zeitbudget), laeuft die Pruefung ohne diesen
// Zusatz weiter wie bisher.
// ============================================================================

var SYN_MAX_WORDS = 120;            // Suchwoerter je Pruefung
var SYN_MAX_CONCEPTS_PER_WORD = 6;  // Konzepte je Suchwort
var SYN_MAX_LINES_PER_CHUNK = 80;   // Begriffe je Textabschnitt im Prompt
var SYN_PAGE_SIZE = 20;
var SYN_BATCH = 10;                 // parallele Phrase-Anfragen
var SYN_BUDGET_MS = 90000;          // Zeitbudget fuer die Nachschlagen
var SYN_CACHE_PREFIX = 'AC_SYN_V1_';
var SYN_CACHE_TTL = 21600;          // 6 h
var SYN_DEF_MAX_CHARS = 200;

// Erklaert der KI, wie sie die Liste verwenden soll. Steht ueber der Begriffsliste im
// Platzhalter {termList}, damit auch gespeicherte eigene Prompts funktionieren.
var SYN_INSTRUCTIONS =
  'APPROVED TERMINOLOGY from the Kärcher termbase, only the entries relevant to this text. ' +
  'Each line is one concept: the preferred term, other approved terms, and its meaning.\n' +
  'Report type "terminology" when the text\n' +
  '- uses a word or phrase that is NOT one of the approved terms of a concept but means the same thing (synonym, colloquial or alternative name, ' +
  'e.g. a different name for a part that has an approved name) - suggest the preferred term; or\n' +
  '- uses an approved term in a different meaning than the concept (homonym) - suggest the fitting term if one is listed, otherwise explain the mix-up.\n' +
  'Do not report words that already are approved terms in their intended meaning, and do not report a synonym unless you are confident it refers to the listed concept. ' +
  'Quote the word exactly as it appears in the text.\n';

// ─── SCHRITT 1: FACHBEGRIFFE UND ALTERNATIVEN AUS DEM TEXT ──────────────────
function _synCandidatePrompt_(lang, chunkText) {
  return 'You help check Kärcher texts (manufacturer of cleaning equipment) against the company terminology database.\n' +
    'Text language: ' + lang + '.\n\n' +
    'From the text below, list the technical terms and part or product names that a terminology database could contain ' +
    '(nouns or short noun phrases of 1 to 3 words, in base form). For each one give up to 2 alternative names for the same thing ' +
    'that could be the official Kärcher term (synonyms), so they can be looked up as well. ' +
    'Skip generic words, brand names, numbers and units. At most 40 terms.\n\n' +
    'Answer ONLY with valid JSON, without markdown: {"terms":[{"term":"...","alternatives":["..."]}]}\n\n' +
    'Text:\n"""\n' + String(chunkText || '').replace(/"""/g, "'''") + '\n"""';
}

// Antwort -> Liste von Suchwoertern (Begriffe zuerst, dann Alternativen); [] bei Fehler.
function _synParseCandidates_(res) {
  try {
    if (res.getResponseCode() !== 200) return [];
    var data = JSON.parse(res.getContentText());
    var text = data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
    var parsed = JSON.parse(String(text).replace(/```json/gi, '').replace(/```/g, '').trim());
    var terms = Array.isArray(parsed.terms) ? parsed.terms : [];
    var main = [], alts = [];
    terms.forEach(function (t) {
      if (typeof t === 'string') { main.push(t); return; }
      if (!t) return;
      if (t.term) main.push(String(t.term));
      (Array.isArray(t.alternatives) ? t.alternatives : []).forEach(function (a) { if (a) alts.push(String(a)); });
    });
    return _synCleanWords_(main.concat(alts));
  } catch (e) {
    return [];
  }
}

function _synCleanWords_(words) {
  var seen = {}, out = [];
  (words || []).forEach(function (w) {
    w = String(w).replace(/[*"“”]/g, '').replace(/\s+/g, ' ').trim();
    var k = w.toLowerCase();
    if (w.length < 3 || w.length > 60 || seen[k]) return;
    seen[k] = true;
    out.push(w);
  });
  return out;
}

// ─── SCHRITT 2: IN DEN TERMBASES NACHSCHLAGEN ───────────────────────────────
// Ein Konzept (Antwort von /browse) -> { id, tb, terms:[{t, p, f}], def } mit den Begriffen
// der Sprache; null, wenn keiner den Suchbegriff enthaelt.
function _synConceptFromBrowse_(concept, lang, word, tbName) {
  var all = [];
  ((concept && concept.terms) || []).forEach(function (ti) {
    (Array.isArray(ti) ? ti : [ti]).forEach(function (t) { if (t && typeof t === 'object') all.push(t); });
  });
  var want = _glossaryLangBase_(lang);
  var terms = all.filter(function (t) { return _glossaryLangBase_(t.lang || t.language || '') === want && _glossaryTermText_(t); });
  if (!terms.length) return null;
  var q = '*' + word + '*';
  if (!terms.some(function (t) { return _termMatchesQuery_(_glossaryTermText_(t), q); })) return null;
  var def = '';
  terms.concat([concept]).forEach(function (t) {
    if (!def) def = String(t.definition || t.usage || t.description || t.note || t.conceptNote || '').replace(/\s+/g, ' ').trim();
  });
  return {
    id: String(concept.conceptId || concept.id || ''), tb: tbName,
    terms: terms.map(function (t) { return { t: _glossaryTermText_(t), p: t.preferred === true, f: t.forbidden === true }; }),
    def: def.slice(0, SYN_DEF_MAX_CHARS)
  };
}

// Genauer Treffer zuerst, dann Beginn, dann Rest.
function _synRank_(concepts, word) {
  var w = word.toLowerCase();
  function score(c) {
    var best = 3;
    c.terms.forEach(function (t) {
      var l = t.t.toLowerCase();
      if (l === w) best = Math.min(best, 0);
      else if (l.indexOf(w) === 0) best = Math.min(best, 1);
      else best = Math.min(best, 2);
    });
    return best;
  }
  return concepts.map(function (c, i) { return { c: c, s: score(c), i: i }; })
    .sort(function (a, b) { return a.s - b.s || a.i - b.i; })
    .map(function (x) { return x.c; }).slice(0, SYN_MAX_CONCEPTS_PER_WORD);
}

// Schlaegt die Woerter in allen Ziel-Termbases nach. Liefert { byWord: {klein: [Konzept]}, looked, missing }.
// Pro Wort im Cache; nicht erreichte Woerter (Zeitbudget, Fehler) gehen als "missing" zurueck.
function _synLookup_(words, lang) {
  var cache = CacheService.getScriptCache();
  var base = _glossaryLangBase_(lang);
  var byWord = {}, todo = [];
  words.forEach(function (w) {
    var key = SYN_CACHE_PREFIX + base + '_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, w.toLowerCase(), Utilities.Charset.UTF_8));
    var hit = _cacheGetCompressed_(cache, key);
    if (hit) byWord[w.toLowerCase()] = hit.c;
    else todo.push({ w: w, key: key });
  });
  if (!todo.length) return { byWord: byWord, looked: 0, missing: 0 };

  var tbs = _getTargetTermbases_().filter(function (tb) { return _tbQueryLangs_(tb, [lang]).length; });
  if (!tbs.length) return { byWord: byWord, looked: 0, missing: todo.length };
  var auth = _phraseAuth_();
  var deadline = Date.now() + SYN_BUDGET_MS;
  var jobs = [];
  todo.forEach(function (t) { tbs.forEach(function (tb) { jobs.push({ t: t, tb: tb }); }); });

  function request(job) {
    return {
      url: PHRASE_V1 + '/termBases/' + encodeURIComponent(job.tb.uid) + '/browse',
      method: 'post', contentType: 'application/json', headers: { Authorization: auth },
      payload: JSON.stringify({ query: '*' + job.t.w + '*', pageNumber: 0, pageSize: SYN_PAGE_SIZE, queryLang: lang }),
      muteHttpExceptions: true
    };
  }
  var found = {}, failed = {}, reached = {};
  function take(res, job) {
    var data;
    try { data = JSON.parse(res.getContentText()); } catch (e) { failed[job.t.key] = true; return; }
    (data.searchResults || data.concepts || []).forEach(function (c) {
      var mapped = _synConceptFromBrowse_(c, lang, job.t.w, job.tb.name);
      if (mapped) (found[job.t.key] = found[job.t.key] || []).push(mapped);
    });
  }
  for (var i = 0; i < jobs.length && Date.now() < deadline; i += SYN_BATCH) {
    var chunk = jobs.slice(i, i + SYN_BATCH), responses;
    try { responses = UrlFetchApp.fetchAll(chunk.map(request)); }
    catch (e) { chunk.forEach(function (j) { failed[j.t.key] = true; }); continue; }
    responses.forEach(function (res, idx) {
      var job = chunk[idx], code = res.getResponseCode();
      if (code === 429 || code >= 500) {
        Utilities.sleep(1000);
        try { res = UrlFetchApp.fetch(request(job).url, request(job)); code = res.getResponseCode(); } catch (e) { code = 599; }
      }
      reached[job.t.key] = (reached[job.t.key] || 0) + 1;
      if (code === 200) take(res, job); else failed[job.t.key] = true;
    });
  }
  var missing = 0;
  todo.forEach(function (t) {
    if (failed[t.key] || reached[t.key] !== tbs.length) { missing++; return; }   // nicht vollstaendig: nicht cachen
    var list = _synRank_(found[t.key] || [], t.w);
    byWord[t.w.toLowerCase()] = list;
    _cachePutCompressed_(cache, t.key, { c: list }, SYN_CACHE_TTL);
  });
  return { byWord: byWord, looked: todo.length - missing, missing: missing };
}

// ─── SCHRITT 3: BEGRIFFSLISTE FUER DEN PRUEF-PROMPT ─────────────────────────
function _synConceptLine_(c) {
  var allowed = c.terms.filter(function (t) { return !t.f; });
  var forbidden = c.terms.filter(function (t) { return t.f; });
  var main = allowed.filter(function (t) { return t.p; });
  if (!main.length) main = allowed;
  var mainNames = main.map(function (t) { return t.t; });
  var others = allowed.filter(function (t) { return mainNames.indexOf(t.t) === -1; }).map(function (t) { return t.t; });
  if (!mainNames.length) return '';
  return '- ' + mainNames.join(' / ') +
    (others.length ? ' | also approved: ' + others.join(', ') : '') +
    (forbidden.length ? ' | NOT allowed: ' + forbidden.map(function (t) { return t.t; }).join(', ') : '') +
    (c.def ? ' | meaning: ' + c.def : '');
}

// Liste fuer einen Abschnitt aus den Konzepten seiner Suchwoerter: { text, count }; text '' wenn keine.
function _synBlockForWords_(words, byWord) {
  var seen = {}, lines = [];
  (words || []).forEach(function (w) {
    (byWord[w.toLowerCase()] || []).forEach(function (c) {
      var k = c.tb + '|' + (c.id || c.terms.map(function (t) { return t.t; }).join('/'));
      if (seen[k] || lines.length >= SYN_MAX_LINES_PER_CHUNK) return;
      seen[k] = true;
      var line = _synConceptLine_(c);
      if (line) lines.push(line);
    });
  });
  return { text: lines.length ? SYN_INSTRUCTIONS + lines.join('\n') : '', count: lines.length };
}

// Ergebnis je Abschnitt: { blocks: [Text oder ''], words, concepts, missing }.
// cfg: { apiUrl, model, apiKey, temperature }.
function _synContextForChunks_(cfg, lang, chunks) {
  function geminiRequest(chunk) {
    var call = _buildGeminiRequest_(cfg.apiUrl, cfg.model, cfg.apiKey, {
      contents: [{ role: 'user', parts: [{ text: _synCandidatePrompt_(lang, chunk) }] }],
      generationConfig: { temperature: 0 }
    });
    return { url: call.url, method: 'post', contentType: 'application/json', headers: call.headers, payload: JSON.stringify(call.body), muteHttpExceptions: true };
  }
  var requests = chunks.map(geminiRequest);
  var responses = requests.length === 1 ? [_fetchGeminiWithRetry_(requests[0].url, requests[0], 2)] : UrlFetchApp.fetchAll(requests);
  var perChunk = responses.map(function (res, i) {
    if (GEMINI_RETRYABLE_CODES.indexOf(res.getResponseCode()) !== -1 && requests.length > 1) res = _fetchGeminiWithRetry_(requests[i].url, requests[i], 2);
    return _synParseCandidates_(res);
  });

  // Alle Woerter, Begriffe vor Alternativen (je Abschnitt schon so sortiert), gedeckelt.
  var all = [], seen = {};
  for (var round = 0; all.length < SYN_MAX_WORDS; round++) {
    var added = false;
    perChunk.forEach(function (words) {
      var w = words[round];
      if (w && !seen[w.toLowerCase()] && all.length < SYN_MAX_WORDS) { seen[w.toLowerCase()] = true; all.push(w); added = true; }
      else if (w) added = true;
    });
    if (!added) break;
  }
  var lookup = _synLookup_(all, lang);
  var conceptCount = 0;
  var blocks = perChunk.map(function (words) {
    var block = _synBlockForWords_(words, lookup.byWord);
    conceptCount += block.count;
    return block.text;
  });
  return { blocks: blocks, words: all.length, concepts: conceptCount, missing: lookup.missing };
}

// Tests the synonym/homonym support of the Author Check (TermSynonyms.js): candidate words
// from the AI, lookup of the approved terms in the termbase, list for the check prompt.
// Phrase and Gemini are replaced by stand-ins.
//
//   node test/term-synonyms.cjs
//
// Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const checks = [];
function check(name, ok, detail) { checks.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + String(detail).slice(0, 220) + ')' : '')); }

const store = {};
let phraseCalls = [];
let geminiAnswer = null;
let phraseFail = false;
function resp(code, body) { return { getResponseCode: function() { return code; }, getContentText: function() { return typeof body === 'string' ? body : JSON.stringify(body); } }; }
function term(text, extra) { return Object.assign({ text: text, lang: 'de' }, extra || {}); }
// The termbase: approved terms only (no forbidden), as in the real one.
const TB = [
  { conceptId: 'c1', terms: [term('Bürstenkopf', { preferred: true }), term('Scheuerkopf'), { text: 'Brush head', lang: 'en' }], definition: 'Werkzeugeinheit, die die Schrubbbürsten aufnimmt' },
  { conceptId: 'c2', terms: [term('Walzenbürstenkopf')] },
  { conceptId: 'c3', terms: [term('Bürstenkopftechnik')] },
  { conceptId: 'c4', terms: [term('Düse'), { text: 'Nozzle', lang: 'en' }] }
];
function phrase(opts) {
  phraseCalls.push(JSON.parse(opts.payload));
  if (phraseFail) return resp(500, {});
  const q = JSON.parse(opts.payload).query.replace(/\*/g, '').toLowerCase();
  return resp(200, { searchResults: TB.filter(function(c) { return c.terms.some(function(t) { return t.lang === 'de' && t.text.toLowerCase().indexOf(q) !== -1; }); }) });
}
const ctx = vm.createContext({
  console: console, Date: Date, JSON: JSON, Math: Math, RegExp: RegExp,
  Logger: { log: function() {} },
  PHRASE_V1: 'https://phrase.test',
  GEMINI_RETRYABLE_CODES: [429, 500, 502, 503, 504],
  _phraseAuth_: function() { return 'ApiToken x'; },
  _getTargetTermbases_: function() { return [{ uid: 'tb1', name: 'TB 1', langs: ['de', 'en'] }]; },
  _tbQueryLangs_: function(tb, langs) { return langs; },
  _termMatchesQuery_: function(text, q) { const core = q.replace(/\*/g, '').toLowerCase(); return String(text).toLowerCase().indexOf(core) !== -1; },
  _cachePutCompressed_: function(c, k, o) { store[k] = JSON.stringify(o); },
  _cacheGetCompressed_: function(c, k) { return store[k] ? JSON.parse(store[k]) : null; },
  CacheService: { getScriptCache: function() { return {}; } },
  Utilities: {
    sleep: function() {}, DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
    computeDigest: function(a, s) { return crypto.createHash('md5').update(s).digest(); },
    base64EncodeWebSafe: function(b) { return Buffer.from(b).toString('base64url'); }
  },
  _buildGeminiRequest_: function(url, model, key, body) { return { url: url + model, headers: {}, body: body }; },
  _fetchGeminiWithRetry_: function(url, opts) { return gemini(opts); },
  UrlFetchApp: {
    fetchAll: function(reqs) { return reqs.map(function(r) { return r.url.indexOf('phrase.test') !== -1 ? phrase(r) : gemini(r); }); },
    fetch: function(url, opts) { return url.indexOf('phrase.test') !== -1 ? phrase(opts) : gemini(opts); }
  }
});
function gemini(opts) {
  if (geminiAnswer === 'fail') return resp(500, {});
  return resp(200, { candidates: [{ content: { parts: [{ text: geminiAnswer }] } }] });
}
vm.runInContext(fs.readFileSync(path.join(ROOT, 'TermGlossary.js'), 'utf8'), ctx, { filename: 'TermGlossary.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'TermSynonyms.js'), 'utf8'), ctx, { filename: 'TermSynonyms.js' });
function reset() { Object.keys(store).forEach(function(k) { delete store[k]; }); phraseCalls = []; phraseFail = false; }

// 1. the AI answer becomes search words: terms first, then alternatives, cleaned
let words = ctx._synParseCandidates_(resp(200, { candidates: [{ content: { parts: [{ text: '```json\n{"terms":[{"term":"Schrubbkopf","alternatives":["Bürstenkopf","Scheuerkopf"]},{"term":"Düse","alternatives":[]},{"term":"a"},"Akku"]}\n```' }] } }] }));
check('candidates: terms first, then alternatives, short words dropped', words.join('|') === 'Schrubbkopf|Düse|Akku|Bürstenkopf|Scheuerkopf', words.join('|'));
check('candidates: invalid answer gives empty list', ctx._synParseCandidates_(resp(200, { candidates: [{ content: { parts: [{ text: 'kein json' }] } }] })).length === 0 && ctx._synParseCandidates_(resp(500, {})).length === 0);

// 2. lookup: "Schrubbkopf" is not in the termbase, its alternative "Bürstenkopf" is
reset();
let lk = ctx._synLookup_(['Schrubbkopf', 'Bürstenkopf'], 'de');
check('lookup: unknown word gives no concept, known word does', lk.byWord['schrubbkopf'].length === 0 && lk.byWord['bürstenkopf'].length >= 1 && lk.missing === 0, JSON.stringify(Object.keys(lk.byWord)));
const bk = lk.byWord['bürstenkopf'];
check('lookup: exact match ranked first, only German terms, meaning kept', bk[0].id === 'c1' && bk[0].terms.map(function(t) { return t.t; }).join() === 'Bürstenkopf,Scheuerkopf' && /Schrubbbürsten/.test(bk[0].def), JSON.stringify(bk[0]));
const calls = phraseCalls.length;
ctx._synLookup_(['Schrubbkopf', 'Bürstenkopf'], 'de');
check('lookup: second run comes from the cache (also empty results)', phraseCalls.length === calls);
reset(); phraseFail = true;
lk = ctx._synLookup_(['Bürstenkopf'], 'de');
check('lookup: Phrase error is reported as missing and not cached', lk.missing === 1 && Object.keys(store).length === 0, JSON.stringify(lk));

// 3. list for the prompt
reset();
lk = ctx._synLookup_(['Bürstenkopf', 'Düse'], 'de');
const line = ctx._synConceptLine_(lk.byWord['bürstenkopf'][0]);
check('line: preferred term, other approved terms, meaning', line === '- Bürstenkopf | also approved: Scheuerkopf | meaning: Werkzeugeinheit, die die Schrubbbürsten aufnimmt', line);
check('line: forbidden terms (if maintained) are marked', ctx._synConceptLine_({ terms: [{ t: 'Alt', p: false, f: true }, { t: 'Neu', p: false, f: false }], def: '' }) === '- Neu | NOT allowed: Alt');
const block = ctx._synBlockForWords_(['Schrubbkopf', 'Bürstenkopf'], lk.byWord);
check('block: instruction text plus the approved terms of the chunk', block.count >= 1 && /synonym/.test(block.text) && /homonym/.test(block.text) && block.text.indexOf('- Bürstenkopf') !== -1 && block.text.indexOf('Düse') === -1, block.text.slice(-200));
check('block: no words found gives empty text', ctx._synBlockForWords_(['Schrubbkopf'], lk.byWord).text === '');

// 4. whole flow for two chunks: Schrubbkopf -> Bürstenkopf reaches the prompt of chunk 1 only
reset();
geminiAnswer = '{"terms":[{"term":"Schrubbkopf","alternatives":["Bürstenkopf"]}]}';
const cfg = { apiUrl: 'https://gemini.test/', model: 'm', apiKey: 'k', temperature: 0 };
let r = ctx._synContextForChunks_(cfg, 'de', ['Die Scheuersaugmaschine benötigt einen neuen Schrubbkopf.']);
check('flow: synonym text leads to the approved term in the list', r.blocks.length === 1 && r.blocks[0].indexOf('- Bürstenkopf') !== -1 && r.concepts >= 1 && r.words === 2, JSON.stringify({ w: r.words, c: r.concepts }));
geminiAnswer = 'fail';
let threw = false;
try { r = ctx._synContextForChunks_(cfg, 'de', ['Text 1', 'Text 2']); } catch (e) { threw = true; }
check('flow: failing AI gives empty lists, no exception', !threw && r.blocks.length === 2 && r.blocks.every(function(b) { return b === ''; }));

const failed = checks.filter(function(c) { return !c; }).length;
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' passed');
process.exit(failed ? 1 : 0);

// Tests the termbase glossary of the Author Check (TermGlossary.js) and the notes of
// the whole-document prompts (DocPrompts.js). The Phrase API is replaced by a stand-in.
//
//   node test/term-glossary.cjs
//
// Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const checks = [];
function check(name, ok, detail) { checks.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + String(detail).slice(0, 200) + ')' : '')); }

// ── Phrase stand-in: a termbase with N concepts, 50 per page ────────────────
let concepts = [];
let fetchLog = [];
let failPage = -1;
const store = {};
function resp(code, body) { return { getResponseCode: function() { return code; }, getContentText: function() { return JSON.stringify(body); } }; }
function phrase(opts) {
  const b = JSON.parse(opts.payload);
  fetchLog.push(b.pageNumber);
  if (b.pageNumber === failPage) return resp(429, {});
  const from = b.pageNumber * 50;
  return resp(200, { searchResults: concepts.slice(from, from + 50), totalPages: Math.ceil(concepts.length / 50) });
}
const ctx = vm.createContext({
  console: console, Date: Date, JSON: JSON, Math: Math, RegExp: RegExp,
  Logger: { log: function() {} },
  PHRASE_V1: 'https://phrase.test',
  _phraseAuth_: function() { return 'ApiToken x'; },
  _getTargetTermbases_: function() { return [{ uid: 'tb1', name: 'TB 1' }]; },
  _cachePutCompressed_: function(c, k, o) { store[k] = JSON.stringify(o); },
  _cacheGetCompressed_: function(c, k) { return store[k] ? JSON.parse(store[k]) : null; },
  CacheService: { getScriptCache: function() { return {}; } },
  Utilities: { sleep: function() {} },
  UrlFetchApp: {
    fetchAll: function(reqs) { return reqs.map(function(r) { return phrase(r); }); },
    fetch: function(url, opts) { return phrase(opts); }
  }
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'TermGlossary.js'), 'utf8'), ctx, { filename: 'TermGlossary.js' });
const msg = function(key, v) { return key + ':' + JSON.stringify(v); };
function term(text, lang, extra) { return Object.assign({ text: text, lang: lang }, extra || {}); }
function concept(terms) { return { terms: terms }; }
function reset() { store && Object.keys(store).forEach(function(k) { delete store[k]; }); fetchLog = []; failPage = -1; }

// 1. language codes: de_DE / DE must be recognised (earlier: strict === 'de')
let e = ctx._glossaryEntriesFromConcept_(concept([term('Sauger', 'de_DE', { forbidden: true }), term('Nass-Trockensauger', 'DE')]), 'de');
check('language: de_DE and DE match "de"', e.length === 1 && e[0].wrong === 'Sauger' && e[0].correct[0] === 'Nass-Trockensauger', JSON.stringify(e));
e = ctx._glossaryEntriesFromConcept_(concept([term('Sauger', 'en', { forbidden: true }), term('Vacuum', 'en')]), 'de');
check('language: other language gives no entry', e.length === 0);

// 2. synonyms: all allowed terms stay, "preferred" decides when set
e = ctx._glossaryEntriesFromConcept_(concept([term('Altbegriff', 'de', { forbidden: true }), term('Alpha', 'de'), term('Beta', 'de')]), 'de');
check('synonyms: all allowed terms are kept', e[0].correct.join(',') === 'Alpha,Beta', JSON.stringify(e));
e = ctx._glossaryEntriesFromConcept_(concept([term('Altbegriff', 'de', { forbidden: true }), term('Alpha', 'de'), term('Beta', 'de', { preferred: true })]), 'de');
check('synonyms: preferred term wins', e[0].correct.join(',') === 'Beta', JSON.stringify(e));
e = ctx._glossaryEntriesFromConcept_(concept([term('Alpha', 'de', { forbidden: true }), term('alpha', 'de')]), 'de');
check('same word forbidden and allowed in one concept: no entry', e.length === 0);

// 3. homonyms: same forbidden word in two concepts -> one entry, both corrections
const merged = ctx._glossaryMerge_([
  { wrong: 'Düse', correct: ['Hochdruckdüse'], cs: false },
  { wrong: 'düse', correct: ['Sprühdüse'], cs: false },
  { wrong: 'Pad', correct: ['Reinigungspad'], cs: false }]);
check('homonyms: merged into one entry with both corrections', merged.length === 2 && merged[0].correct.join('/') === 'Hochdruckdüse/Sprühdüse' && merged[0].multi === true && merged[1].multi === false, JSON.stringify(merged));

// 4. text matching
const gl = ctx._glossaryMerge_([
  { wrong: 'Sauger', correct: ['Nass-Trockensauger'], cs: false },
  { wrong: 'Hochdruck reiniger', correct: ['Hochdruckreiniger'], cs: false },
  { wrong: 'Düse', correct: ['Hochdruckdüse', 'Sprühdüse'], cs: false },
  { wrong: 'Düse', correct: ['Hochdruckdüse'], cs: false }]);
let issues = ctx._glossaryFindIssues_(gl, 'Der Sauger saugt. Zwei Sauger. Des Saugers Filter. Saugerstange. Hochdruck  reiniger.', msg);
const by = {}; issues.forEach(function(i) { by[i.original] = i; });
check('match: single word, inflected forms and counts', by['Sauger'] && by['Sauger'].suggestion === 'Nass-Trockensauger' && /"n":2/.test(by['Sauger'].explanation) && by['Saugers'] && by['Saugers'].suggestion === 'Nass-Trockensaugers', Object.keys(by).join('|'));
check('match: compound word "Saugerstange" is not a hit', !by['Saugerstange'] && issues.every(function(i) { return i.original.indexOf('stange') === -1; }));
check('match: multi-word term with flexible whitespace', !!by['Hochdruck  reiniger'] && by['Hochdruck  reiniger'].suggestion === 'Hochdruckreiniger');
issues = ctx._glossaryFindIssues_(gl, 'Die Düse ist defekt.', msg);
check('match: homonym gives all corrections and the "depends on meaning" text', issues.length === 1 && issues[0].suggestion === 'Hochdruckdüse / Sprühdüse' && /Multi/.test(issues[0].explanation), JSON.stringify(issues));
issues = ctx._glossaryFindIssues_(gl, 'Der Nass-Sauger und der Nass-Trockensauger.', msg);
check('match: forbidden word inside the correct term is no error', issues.length === 1 && issues[0].original === 'Sauger', JSON.stringify(issues));
const cs = ctx._glossaryMerge_([{ wrong: 'Pad', correct: ['Reinigungspad'], cs: true }]);
check('match: case-sensitive term', ctx._glossaryFindIssues_(cs, 'ein pad und ein Pad', msg).map(function(i) { return i.original; }).join() === 'Pad');

// 5. the whole document is scanned (earlier only the first 60,000 characters)
const longText = 'Text. '.repeat(40000) + 'Am Ende steht ein Sauger.';
issues = ctx._glossaryFindIssues_(gl, longText, msg);
check('long document: finding after 240,000 characters', issues.length === 1 && issues[0].original === 'Sauger');

// 6. the AI gets only entries that occur in the section
const part = ctx._glossaryForText_(gl, 'nur ein Sauger hier');
check('prompt list: only entries occurring in the text', part.length === 1 && part[0].wrong === 'Sauger');

// 7. reading all pages (earlier: at most 20 pages), resumable on error
concepts = [];
for (let i = 0; i < 1234; i++) concepts.push(concept([term('Alt' + i, 'de', { forbidden: true }), term('Neu' + i, 'de')]));
reset();
let info = ctx._buildTerminologyGlossaryInfo_('de');
check('termbase: all 1234 concepts are read (25 pages)', info.entries.length === 1234 && !info.partial, info.entries.length + ' entries, pages ' + fetchLog.length);
const before = fetchLog.length;
info = ctx._buildTerminologyGlossaryInfo_('de');
check('termbase: second run comes from the cache without requests', info.entries.length === 1234 && fetchLog.length === before);
reset(); failPage = 12;
info = ctx._buildTerminologyGlossaryInfo_('de');
check('termbase: a failing page gives a partial glossary, not a silent cut', info.partial === true && info.entries.length === 12 * 50, info.entries.length);
failPage = -1; fetchLog = [];
info = ctx._buildTerminologyGlossaryInfo_('de');
check('termbase: next run continues at the failed page', !info.partial && info.entries.length === 1234 && Math.min.apply(null, fetchLog) === 12, 'first page ' + Math.min.apply(null, fetchLog));

// 8. a disabled prompt is no longer reported
const dp = vm.createContext({
  PropertiesService: { getScriptProperties: function() { return { getProperty: function() { return null; } }; } },
  _rulesLanguageSupported_: function() { return true; },
  apiGetRulesConfig: function() { return []; },
  _ct_: function(k) { return k; }
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'DocPrompts.js'), 'utf8'), dp, { filename: 'DocPrompts.js' });
const rules = [
  { Name: 'CUSTOM_1', Description: 'Aus', RuleKind: 'PROMPT', PromptScope: 'DOCUMENT', CustomPrompt: 'x', IsEnabled: false },
  { Name: 'CUSTOM_2', Description: 'An', RuleKind: 'PROMPT', PromptScope: 'DOCUMENT', CustomPrompt: 'y', IsEnabled: true }];
const notes = dp._docPromptNotes_('de', rules);
check('disabled whole-document prompt: no note', notes.length === 0, JSON.stringify(notes));

// 9. Diagnose: shows how a word is stored and whether it is in the glossary
reset();
concepts = [concept([term('Schrubbkopf', 'de', { forbidden: true }), term('Bürstenkopf', 'de', { preferred: true })]),
            concept([term('Düse', 'de', { forbidden: true }), term('Hochdruckdüse', 'de')])];
const logs = [];
ctx.Logger.log = function(x) { logs.push(String(x)); };
ctx._searchCore_ = function() { return { concepts: [{ categoryLabel: 'General', sourceTerm: { term: 'Bürstenkopf', lang: 'de', status: 'APPROVED', forbidden: false, preferred: true },
  translations: [{ term: 'Schrubbkopf', lang: 'de', status: 'NEW', forbidden: true, preferred: false }] }], failed: 0 }; };
ctx._glossaryDiagnose_('Schrubbkopf', 'de');
check('diagnose: finds the word as forbidden term', logs.some(function(l) { return /Eintrag im Glossar \(falsch\): "Schrubbkopf" -> Bürstenkopf/.test(l); }), logs.join(' // '));
check('diagnose: shows the Phrase flags', logs.some(function(l) { return /Schrubbkopf \{status=NEW, forbidden=true/.test(l); }));
logs.length = 0;
ctx._glossaryDiagnose_('Scheuerkopf', 'de');
check('diagnose: says clearly when the word is not in the glossary', logs.some(function(l) { return /NICHT als verbotener Begriff/.test(l); }));

const failed = checks.filter(function(c) { return !c; }).length;
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' passed');
process.exit(failed ? 1 : 0);

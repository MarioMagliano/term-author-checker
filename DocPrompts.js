// ============================================================================
// GESAMTDOKUMENT-PROMPTS (KI-Prompt-Regeln mit PromptScope = 'DOCUMENT')
// ----------------------------------------------------------------------------
// Normale KI-Prompt-Regeln werden als eine Zeile ("SPECIFIC CHECK ...") in den
// Grammatik-Prompt eingebaut und pro Abschnitt (PDF: je 4 Seiten) geprueft; die
// Antwort muss ins Schema {"issues":[{original, suggestion}]} passen. Ein Prompt,
// der das GANZE Dokument braucht (z. B. Widersprueche zwischen Seite 3 und 90)
// und ein eigenes Ausgabeformat vorgibt, ging dort unter - Gemini lieferte nur
// Grammatikfunde.
//
// Regeln mit PromptScope 'DOCUMENT' laufen deshalb getrennt: eine eigene Anfrage
// pro Regel mit dem vollstaendigen Dokument (PDF bzw. Text), der Prompt wird
// unveraendert gesendet, kein JSON-Zwang. Die Antworten (Markdown) landen in
// einem Google Doc ("Bericht"), das im Ergebnis verlinkt wird.
// ============================================================================

var DOC_PROMPT_SCOPE = 'DOCUMENT';
var DOC_PROMPT_MAX = 5; // so viele Gesamtdokument-Prompts pro Pruefung (parallel); Standard, siehe _docPromptMax_
// Groesste PDF, die einem Gesamtdokument-Prompt direkt beiliegt. Gemini nimmt
// hoechstens 20 MB pro Anfrage, Base64 macht aus 13 MB ~17,3 MB, dazu kommt der
// Prompt (bis 50.000 Zeichen). Frueher galt hier dieselbe Grenze wie fuer die
// Seitenpakete (15 MB, als Base64 ~20 MB): grosse Anleitungen lagen nach dem
// Verkleinern knapp darunter, die Anfrage mit der ganzen PDF scheiterte (am
// Limit oder am Proxy davor) und der Prompt fehlte im Ergebnis.
// Skripteigenschaft DOC_PROMPT_PDF_MAX_MB setzt einen anderen Wert (z. B. wenn
// ein Proxy weniger annimmt). Groessere PDFs laufen ueber den Seitentext, eine
// abgelehnte Anfrage mit PDF wird mit dem Seitentext wiederholt (DriveAddon.gs).
var DOC_PROMPT_PDF_MAX_BYTES = 13 * 1024 * 1024;
// So viel Text aus den uebrigen eigenen Regeln (z. B. importierter
// Redaktionsleitfaden) geht als Referenz mit.
var DOC_PROMPT_GUIDE_MAX_CHARS = 30000;

// So viele Gesamtdokument-Prompts laufen je Pruefung: Skripteigenschaft DOC_PROMPT_MAX
// (1 bis 12), sonst DOC_PROMPT_MAX. Mehr Prompts bedeuten mehr gleichzeitige Anfragen
// mit dem ganzen Dokument; das Ergebnis kommt erst, wenn der langsamste fertig ist.
function _docPromptMax_() {
  var n = parseInt(PropertiesService.getScriptProperties().getProperty('DOC_PROMPT_MAX') || '', 10);
  return n > 0 ? Math.min(n, 12) : DOC_PROMPT_MAX;
}

function _docPromptPdfMaxBytes_() {
  var mb = parseFloat(PropertiesService.getScriptProperties().getProperty('DOC_PROMPT_PDF_MAX_MB') || '');
  return mb > 0 ? Math.round(mb * 1024 * 1024) : DOC_PROMPT_PDF_MAX_BYTES;
}

function _isDocScopePrompt_(r) {
  return !!(r && r.PromptScope === DOC_PROMPT_SCOPE && (r.RuleKind === 'PROMPT' || r.CustomPrompt));
}

// Aktive Gesamtdokument-Prompts einer Regelliste (nur Felder, die gebraucht werden).
// guide: die uebrigen aktiven eigenen Regeln als Referenz (siehe _docPromptGuide_).
function _docPromptsFromRules_(rules) {
  var guide = _docPromptGuide_(rules);
  return (rules || []).filter(function(r) { return r.IsEnabled && _isDocScopePrompt_(r); })
    .slice(0, _docPromptMax_())
    .map(function(r) {
      return { name: r.Name, title: String(r.Description || r.Name || 'Prompt'), prompt: String(r.CustomPrompt || r.Description || ''), guide: guide };
    });
}

// Ein Prompt aus einem Gem verweist oft auf den "hinterlegten Redaktionsleitfaden".
// Zur Pruefzeit gibt es keine Gem-Wissensdateien - die aus dem Leitfaden
// importierten eigenen Regeln liegen aber im Regelwerk. Sie gehen deshalb als
// Referenz mit (nur eigene Regeln, keine Standardregeln, keine Gesamtdokument-Prompts).
function _docPromptGuide_(rules) {
  var lines = [], len = 0, more = 0;
  (rules || []).forEach(function(r) {
    if (!r || !r.IsEnabled || _isDocScopePrompt_(r) || String(r.Name || '').indexOf('CUSTOM_') !== 0) return;
    var head = [r.Section, r.Subsection].filter(function(x) { return x && x !== 'General'; }).join(' > ');
    var line = '- ' + (head ? '[' + head + '] ' : '') + String(r.Description || '').replace(/\s+/g, ' ').trim();
    var p = r.RuleKind === 'PROMPT' && r.CustomPrompt && r.CustomPrompt !== r.Description
      ? String(r.CustomPrompt).replace(/\s+/g, ' ').trim() : '';
    if (p) line += ' -- ' + p;
    if (len + line.length > DOC_PROMPT_GUIDE_MAX_CHARS) { more++; return; }
    lines.push(line);
    len += line.length + 1;
  });
  if (more) lines.push('- (' + more + ' further rules omitted for length)');
  return lines.join('\n');
}

// Hinweise, warum bei einer Pruefung kein (oder nicht jeder) Gesamtdokument-Prompt
// lief. Frueher lief die Pruefung dann einfach ohne - fuer den Nutzer sah es aus,
// als sei der importierte Prompt ignoriert worden. Liefert Texte in der UI-Sprache.
function _docPromptNotes_(lang, rules) {
  var notes = [];
  var mine = (rules || []).filter(function(r) { return r && String(r.Name || '').indexOf('CUSTOM_') === 0 && r.RuleKind === 'PROMPT'; });
  if (!_rulesLanguageSupported_(lang)) {
    var other = [];
    ['de', 'en'].forEach(function(l) {
      try {
        apiGetRulesConfig(l).forEach(function(r) { if (r.IsEnabled && _isDocScopePrompt_(r)) other.push(r.Description || r.Name); });
      } catch (e) {}
    });
    if (other.length) notes.push(_ct_('d.docNoteLang', { lang: String(lang || '').toUpperCase(), names: other.join(', ') }));
    return notes;
  }
  var active = mine.filter(function(r) { return r.IsEnabled && _isDocScopePrompt_(r); });
  var maxPrompts = _docPromptMax_();
  if (active.length > maxPrompts) {
    notes.push(_ct_('d.docNoteMax', { n: active.length, max: maxPrompts,
      names: active.slice(maxPrompts).map(function(r) { return r.Description || r.Name; }).join(', ') }));
  }
  mine.forEach(function(r) {
    // Ein bewusst ausgeschalteter Prompt wird nicht gemeldet: wer ihn deaktiviert,
    // weiss, dass er nicht laeuft (frueher kam hier "ist ausgeschaltet und lief nicht").
    // Lange Pruefanweisungen mit eigenem Berichtsformat gehen "pro Abschnitt"
    // (je 4 Seiten, nur Funde im Listenformat) praktisch unter.
    if (r.IsEnabled && !_isDocScopePrompt_(r) && String(r.CustomPrompt || '').length > 2000) {
      notes.push(_ct_('d.docNotePassage', { name: r.Description || r.Name }));
    }
  });
  if (!active.length) {
    var otherLang = lang === 'de' ? 'en' : 'de', there = [];
    try {
      apiGetRulesConfig(otherLang).forEach(function(r) { if (r.IsEnabled && _isDocScopePrompt_(r)) there.push(r.Description || r.Name); });
    } catch (e) {}
    if (there.length) {
      notes.push(_ct_('d.docNoteOtherLang', { lang: lang.toUpperCase(), other: otherLang.toUpperCase(), names: there.join(', ') }));
    }
  }
  return notes;
}

// Rahmen um den Prompt: nur Fakten, die das Modell sonst nicht kennt (Datum,
// Dateiname, Seitenzahl). Der Prompt selbst bleibt unveraendert und bestimmt
// Vorgehen und Ausgabeformat.
// ctx: { fileName, pages, isPdf, text, fromPdf } - fromPdf: der Text wurde aus
// einer PDF gelesen, die fuer eine Anfrage zu gross war (Seitenmarken im Text).
function _docPromptText_(dp, ctx) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Berlin', 'dd.MM.yyyy');
  var facts = [
    'Check date (today): ' + today,
    'Document: ' + (ctx.fileName || '(unnamed)'),
    ctx.pages ? 'Total pages: ' + ctx.pages : '',
    ctx.isPdf ? 'The complete original document is attached as a PDF. Page numbers refer to the PDF pages.'
      : ctx.fromPdf ? 'The PDF was too large to attach. Its complete text (all pages, extracted page by page, without images) ' +
                      'follows after the instructions between """ markers. Each page starts with a line "=== Page N of M ==="; ' +
                      'page numbers refer to these markers. Text in images or drawings is not available - mark findings that depend on it as uncertain.'
      : 'The complete document text follows after the instructions between """ markers.'
  ].filter(String).join('\n');
  var guide = dp.guide
    ? '=== REFERENCE: RULES FROM THE USER\'S RULE SET ===\n' +
      'These are the custom rules active in the user\'s rule set (for example imported from the editorial style guide / ' +
      'Redaktionsleitfaden). If the instructions refer to a style guide, Redaktionsleitfaden or knowledge file, ' +
      'use these rules as that reference. Knowledge files of a Gemini Gem are not available.\n' +
      dp.guide + '\n=== END OF REFERENCE ===\n\n'
    : '';
  return 'CONTEXT (provided by the tool):\n' + facts + '\n\n' +
    'Follow the instructions below exactly. Work on the WHOLE document, not on single pages. ' +
    'Write your answer in Markdown, in the output format the instructions define. Support every finding in your answer with the page number and a verbatim quote ' +
    'from the document, and do not report a finding that you cannot support with a quote.\n\n' +
    '=== INSTRUCTIONS ===\n' + dp.prompt + '\n=== END OF INSTRUCTIONS ===\n\n' + guide +
    DOC_PROMPT_FINDINGS_RULES +
    (ctx.isPdf ? '' : '\n\n"""\n' + String(ctx.text || '').replace(/"""/g, "'''") + '\n"""');
}

// Zusatz des Tools (hat Vorrang vor "antworte ausschliesslich mit ..." im Prompt):
// nach dem Bericht dieselben Befunde maschinenlesbar, damit sie als Kommentar an
// der richtigen Stelle im Dokument landen (kommentierte PDF, Notiz in Docs/
// Sheets/Slides). Jede beteiligte Stelle eines Befunds wird ein eigener Eintrag.
var DOC_PROMPT_MARKER = '===TERMCHECK_FINDINGS===';
var DOC_PROMPT_FINDINGS_RULES =
  'TOOL REQUIREMENT (takes precedence over any "answer only with ..." rule above): after your complete answer, ' +
  'add a line containing only ' + DOC_PROMPT_MARKER + ' and then valid JSON (no markdown, no code block) in exactly this structure:\n' +
  '{"issues":[{"location":"...","original":"...","suggestion":"...","explanation":"...","severity":"kritisch","evidence":"...","replaceable":false}]}\n' +
  'Rules for this JSON:\n' +
  '- One entry per affected passage. A finding that involves several pages (e.g. a contradiction between page 3 and page 90) ' +
  'gets one entry for EACH involved passage, so every passage can be commented in the document.\n' +
  '- "original": an EXACT, contiguous, verbatim quote from the document (a few words up to one sentence, ' +
  'copied character by character, no ellipsis, no paraphrase), so it can be found in the document text.\n' +
  '- "location": page number as "Page N" (PDF) or the section/heading, if identifiable.\n' +
  '- "suggestion": the concrete correction for this passage (replacement text if the passage itself should be reworded, ' +
  'otherwise a short instruction).\n' +
  '- "explanation": the finding in the language of the instructions, including the other involved pages/passages ' +
  '(e.g. "Contradiction 1: contradicts page 105 ...").\n' +
  '- "severity": exactly one of "kritisch", "mittel", "niedrig". "kritisch" = safety- or legally relevant, or prevents correct use; must be fixed before release. ' +
  '"mittel" = factually wrong or misleading, should be fixed. "niedrig" = improvement without risk.\n' +
  '- "evidence": the concrete basis of the finding, with page numbers: for a contradiction the other passage as a verbatim quote with its page; ' +
  'for a rule, guideline or standard finding the rule, guideline passage or standard topic it violates (name a clause number only if you are sure of it). ' +
  'Never invent a source.\n' +
  '- "replaceable": true ONLY if "suggestion" is a drop-in replacement text for "original", otherwise false.\n' +
  '- No findings: {"issues":[]}.';

// Trennt die Antwort in Bericht (Markdown) und Befunde (JSON nach dem Marker).
function _splitDocPromptAnswer_(text) {
  var idx = text.lastIndexOf(DOC_PROMPT_MARKER);
  var report = idx === -1 ? text : text.slice(0, idx);
  var tail = idx === -1 ? '' : text.slice(idx + DOC_PROMPT_MARKER.length);
  var issues = [];
  if (tail) {
    var clean = tail.replace(/```json/gi, '').replace(/```/g, '').trim();
    var start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    try {
      var parsed = JSON.parse(clean.slice(start, end + 1));
      issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    } catch (e) {
      Logger.log('_splitDocPromptAnswer_: Befunde nicht lesbar: ' + (e.message || e));
    }
  }
  return { report: report.trim(), issues: issues };
}

// Befunde eines Gesamtdokument-Prompts in das normale Issue-Format bringen
// (Typ "prompt", Regelname fuer Anzeige und Kommentar).
function _docPromptIssues_(dp, raw) {
  return (raw || []).filter(function(i) { return i && i.original && String(i.original).trim(); }).map(function(i) {
    return {
      type: 'prompt',
      rule: dp.title,
      location: String(i.location || ''),
      original: String(i.original).trim(),
      suggestion: String(i.suggestion || '').trim() || '–',
      explanation: String(i.explanation || ''),
      severity: _docSeverity_(i.severity, i.explanation),
      evidence: String(i.evidence || '').trim(),
      replaceable: i.replaceable === true
    };
  });
}

// Schwere eines Fundes: 'kritisch', 'mittel', 'niedrig' oder '' (ohne Einstufung). Nimmt auch
// englische Werte und - fuer aeltere Prompts - ein "Schwere: ..." am Anfang der Erklaerung.
function _docSeverity_(raw, explanation) {
  var s = String(raw === undefined || raw === null ? '' : raw).toLowerCase().trim();
  if (!s && explanation) {
    var m = /schwere\s*:\s*(kritisch|mittel|niedrig)/i.exec(String(explanation));
    if (m) s = m[1].toLowerCase();
  }
  if (/^(kritisch|critical|hoch|high)$/.test(s)) return 'kritisch';
  if (/^(mittel|medium|major|moderate)$/.test(s)) return 'mittel';
  if (/^(niedrig|low|minor|gering)$/.test(s)) return 'niedrig';
  return '';
}

// Alle Befunde aus den Berichten (fuer die Issue-Liste).
function _docPromptAllIssues_(reports) {
  var out = [];
  (reports || []).forEach(function(r) { (r.issues || []).forEach(function(i) { out.push(i); }); });
  return out;
}

// Baut die UrlFetch-Anfrage fuer einen Gesamtdokument-Prompt. pdfBytes ODER text.
function _docPromptRequest_(cfg, dp, ctx, pdfBytes) {
  var parts = [{ text: _docPromptText_(dp, ctx) }];
  if (pdfBytes) parts.push({ inlineData: { mimeType: 'application/pdf', data: Utilities.base64Encode(pdfBytes) } });
  var call = _buildGeminiRequest_(cfg.apiUrl, cfg.model, cfg.apiKey, {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { temperature: cfg.temperature }
  });
  return { url: call.url, method: 'post', contentType: 'application/json',
           headers: call.headers, payload: JSON.stringify(call.body), muteHttpExceptions: true };
}

// Antwort -> { title, markdown } oder { title, error }.
function _docPromptResult_(dp, res) {
  try {
    var code = res.getResponseCode();
    if (code !== 200) return { title: dp.title, error: 'AI request failed (' + code + ').', code: code };
    var data = JSON.parse(res.getContentText());
    var cand = data.candidates && data.candidates[0];
    var text = cand && cand.content && cand.content.parts
      ? cand.content.parts.map(function(p) { return p.text || ''; }).join('') : '';
    if (!text.trim()) return { title: dp.title, error: 'Empty AI response' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.' };
    var split = _splitDocPromptAnswer_(text);
    var out = { title: dp.title, markdown: split.report || text, issues: _docPromptIssues_(dp, split.issues) };
    if (cand.finishReason === 'MAX_TOKENS') out.truncated = true;
    return out;
  } catch (e) {
    return { title: dp.title, error: 'Unexpected AI response: ' + (e.message || e) };
  }
}

// Fuehrt alle Gesamtdokument-Prompts parallel aus.
function _runDocPrompts_(cfg, docPrompts, ctx, pdfBytes) {
  if (!docPrompts.length) return [];
  var requests = docPrompts.map(function(dp) { return _docPromptRequest_(cfg, dp, ctx, pdfBytes); });
  var responses = requests.length === 1
    ? [_fetchGeminiWithRetry_(requests[0].url, requests[0], 2)]
    : UrlFetchApp.fetchAll(requests);
  return responses.map(function(res, i) {
    if (requests.length > 1 && GEMINI_RETRYABLE_CODES.indexOf(res.getResponseCode()) !== -1) {
      res = _fetchGeminiWithRetry_(requests[i].url, requests[i], 2);
    }
    return _docPromptResult_(docPrompts[i], res);
  });
}

// ─── BERICHT ALS GOOGLE DOC ────────────────────────────────────────────────
// Das Add-on hat nur documents.currentonly (kein DocumentApp.create). Der Bericht
// wird deshalb als HTML ueber die Drive-API hochgeladen und dabei in ein Google
// Doc umgewandelt (Scope drive ist vorhanden). Liefert die URL.
//
// Aufbau des Berichts:
//   Titel "<Dokumentname> - Pruefbericht", Kopfdaten
//   1 Zusammenfassung (Tabelle Pruefung x Schwere, wichtigste Punkte)
//   2 Checkliste: Was ist zu tun? (nach Schwere gegliedert, je Punkt Stelle, Zitat,
//     Problem, Beleg, Empfehlung)
//   3 Umfassende Erklaerung (der ausfuehrliche Bericht jedes Prompts)
var DOC_REPORT_LABELS = {
  de: {
    report: 'Prüfbericht', document: 'Dokument', date: 'Geprüft am', pages: 'Seiten', basis: 'Grundlage der Prüfung', language: 'Sprache',
    basisPdf: 'PDF', basisText: 'Text aller Seiten (ohne Bilder)', basisMixed: 'PDF, bei einzelnen Prüfungen Text aller Seiten (ohne Bilder)', checks: 'Prüfungen', findings: 'Funde',
    summary: 'Zusammenfassung', topPoints: 'Wichtigste Punkte', check: 'Prüfung', total: 'Gesamt', notRun: 'nicht gelaufen',
    pageChecks: 'Weitere Prüfungen (Seitenprüfung)', pageChecksNote: 'Die Funde der Seitenprüfung stehen in der kommentierten PDF und im Sheet.',
    checklist: 'Checkliste: Was ist zu tun?', checklistIntro: 'Abhaken, sobald die Stelle im Dokument korrigiert ist. Gegliedert nach Schwere, innerhalb der Schwere nach Seite.',
    kritisch: 'Kritisch', kritischHint: 'sicherheits- oder rechtsrelevant, vor der Freigabe beheben',
    mittel: 'Mittel', mittelHint: 'fachlich falsch oder missverständlich, sollte behoben werden',
    niedrig: 'Niedrig', niedrigHint: 'Verbesserung ohne Risiko',
    none: 'Ohne Einstufung', noneHint: 'die Prüfung hat keine Schwere angegeben',
    noFindings: 'Keine Funde.', place: 'Stelle', quote: 'Zitat', problem: 'Problem', evidence: 'Beleg', fix: 'Empfehlung',
    explanation: 'Umfassende Erklärung', explanationIntro: 'Der ausführliche Bericht jeder Prüfung, mit Begründung und Belegen.',
    failed: 'Diese Prüfung ist fehlgeschlagen', truncated: 'Die Antwort der KI wurde an der maximalen Ausgabelänge abgeschnitten.'
  },
  en: {
    report: 'Review report', document: 'Document', date: 'Checked on', pages: 'Pages', basis: 'Basis of the check', language: 'Language',
    basisPdf: 'PDF', basisText: 'Text of all pages (without images)', basisMixed: 'PDF, for some checks the text of all pages (without images)', checks: 'Checks', findings: 'Findings',
    summary: 'Summary', topPoints: 'Most important points', check: 'Check', total: 'Total', notRun: 'did not run',
    pageChecks: 'Other checks (page check)', pageChecksNote: 'The findings of the page check are in the commented PDF and in the sheet.',
    checklist: 'Checklist: what to do', checklistIntro: 'Tick off each item once the passage in the document is corrected. Grouped by severity, within a severity by page.',
    kritisch: 'Critical', kritischHint: 'safety- or legally relevant, fix before release',
    mittel: 'Medium', mittelHint: 'factually wrong or misleading, should be fixed',
    niedrig: 'Low', niedrigHint: 'improvement without risk',
    none: 'No severity', noneHint: 'the check did not give a severity',
    noFindings: 'No findings.', place: 'Location', quote: 'Quote', problem: 'Problem', evidence: 'Evidence', fix: 'Recommendation',
    explanation: 'Full explanation', explanationIntro: 'The detailed report of each check, with reasoning and evidence.',
    failed: 'This check failed', truncated: 'The AI answer was cut off at the maximum output length.'
  }
};
var DOC_REPORT_SEVERITIES = [
  { key: 'kritisch', id: 'K', color: '#C62828' },
  { key: 'mittel', id: 'M', color: '#E65100' },
  { key: 'niedrig', id: 'N', color: '#546E7A' },
  { key: '', id: 'O', color: '#37474F' }
];

// Name des Berichts: wie das geprueften Dokument, mit "Pruefbericht" und Datum.
function _docReportTitle_(fileName, dateStr, language) {
  var L = DOC_REPORT_LABELS[language === 'de' || !language ? 'de' : 'en'];
  var base = String(fileName || 'Document').replace(/\.pdf$/i, '').trim().slice(0, 150) || 'Document';
  return base + ' – ' + L.report + (dateStr ? ' ' + dateStr : '');
}

// Erste Zahl einer Stellenangabe ("Page 12", "Seite 12, Kap. 3") zum Sortieren; ohne Zahl ans Ende.
function _docReportPage_(location) {
  var m = /\d+/.exec(String(location || ''));
  return m ? parseInt(m[0], 10) : 1e9;
}

// Text mit Zeilenumbruechen als HTML (maskiert).
function _docReportText_(s) {
  return String(s == null ? '' : s).split('\n').map(function(l) { return _mdEsc_(l); }).join('<br>');
}

/**
 * Der Bericht als HTML (rein, ohne Apps-Script-Dienste, damit testbar).
 * reports: [{ title, markdown, error, note, truncated, issues: [{ location, original, suggestion,
 *   explanation, severity, evidence }] }]
 * meta (optional): { date, language, pages, mode: 'pdf'|'text'|'mixed', pageChecks: [{ label, n }] }
 */
function _docReportHtml_(fileName, reports, meta) {
  meta = meta || {};
  var L = DOC_REPORT_LABELS[meta.language === 'de' || !meta.language ? 'de' : 'en'];
  var e = _mdEsc_;
  var out = [];

  // Funde einsammeln und nach Schwere gruppieren.
  var groups = {}, perReport = [];
  DOC_REPORT_SEVERITIES.forEach(function(sv) { groups[sv.key] = []; });
  reports.forEach(function(r, ri) {
    var counts = { kritisch: 0, mittel: 0, niedrig: 0, '': 0 };
    (r.issues || []).forEach(function(i) {
      var key = _docSeverity_(i.severity, i.explanation);
      counts[key]++;
      groups[key].push({ issue: i, title: r.title, ri: ri });
    });
    perReport.push(counts);
  });
  DOC_REPORT_SEVERITIES.forEach(function(sv) {
    groups[sv.key].sort(function(a, b) {
      return _docReportPage_(a.issue.location) - _docReportPage_(b.issue.location) || a.ri - b.ri;
    });
    groups[sv.key].forEach(function(it, n) { it.id = sv.id + (n + 1); });
  });
  var totalFindings = DOC_REPORT_SEVERITIES.reduce(function(n, sv) { return n + groups[sv.key].length; }, 0);

  // Titel und Kopfdaten
  out.push('<h1>' + e(_docReportTitle_(fileName, '', meta.language)) + '</h1>');
  var head = [[L.document, e(fileName || '')]];
  if (meta.date) head.push([L.date, e(meta.date)]);
  if (meta.pages) head.push([L.pages, e(meta.pages)]);
  if (meta.mode) head.push([L.basis, e(meta.mode === 'text' ? L.basisText : (meta.mode === 'mixed' ? L.basisMixed : L.basisPdf))]);
  head.push([L.checks, reports.map(function(r) { return e(r.title); }).join('<br>')]);
  head.push([L.findings, String(totalFindings)]);
  out.push('<table border="1" cellpadding="4" style="border-collapse:collapse">' + head.map(function(h) {
    return '<tr><td><b>' + h[0] + '</b></td><td>' + h[1] + '</td></tr>';
  }).join('') + '</table>');

  // 1 Zusammenfassung
  out.push('<h2>1 ' + e(L.summary) + '</h2>');
  var th = function(t) { return '<th>' + e(t) + '</th>'; };
  var rows = ['<tr>' + th(L.check) + DOC_REPORT_SEVERITIES.map(function(sv) { return th(L[sv.key || 'none']); }).join('') + th(L.total) + '</tr>'];
  reports.forEach(function(r, ri) {
    var c = perReport[ri], sum = c.kritisch + c.mittel + c.niedrig + c[''];
    rows.push('<tr><td>' + e(r.title) + (r.error ? ' <i>(' + e(L.notRun) + ')</i>' : '') + '</td>' +
      DOC_REPORT_SEVERITIES.map(function(sv) { return '<td>' + c[sv.key] + '</td>'; }).join('') + '<td><b>' + sum + '</b></td></tr>');
  });
  rows.push('<tr><td><b>' + e(L.total) + '</b></td>' + DOC_REPORT_SEVERITIES.map(function(sv) { return '<td><b>' + groups[sv.key].length + '</b></td>'; }).join('') +
    '<td><b>' + totalFindings + '</b></td></tr>');
  out.push('<table border="1" cellpadding="4" style="border-collapse:collapse">' + rows.join('') + '</table>');

  if (groups.kritisch.length) {
    out.push('<h3>' + e(L.topPoints) + '</h3><ul>' + groups.kritisch.slice(0, 5).map(function(it) {
      return '<li><b>' + it.id + '</b> · ' + e(it.issue.location || '') + ' · ' + e(it.title) + ': ' + _docReportText_(String(it.issue.explanation || it.issue.original || '').slice(0, 240)) + '</li>';
    }).join('') + '</ul>');
  }
  if (meta.pageChecks && meta.pageChecks.length) {
    out.push('<h3>' + e(L.pageChecks) + '</h3><p>' + meta.pageChecks.map(function(p) { return e(p.label) + ': <b>' + e(p.n) + '</b>'; }).join(' · ') +
      '<br><i>' + e(L.pageChecksNote) + '</i></p>');
  }

  // 2 Checkliste
  out.push('<h2>2 ' + e(L.checklist) + '</h2><p><i>' + e(L.checklistIntro) + '</i></p>');
  if (!totalFindings) out.push('<p>' + e(L.noFindings) + '</p>');
  DOC_REPORT_SEVERITIES.forEach(function(sv) {
    var list = groups[sv.key];
    if (!list.length) return;
    var name = L[sv.key || 'none'], hint = L[(sv.key || 'none') + 'Hint'];
    out.push('<h3><span style="color:' + sv.color + '">' + e(name) + ' (' + list.length + ')</span></h3><p><i>' + e(hint) + '</i></p>');
    list.forEach(function(it) {
      var i = it.issue;
      var lines = [];
      if (i.original) lines.push('<b>' + e(L.quote) + ':</b> „' + _docReportText_(i.original) + '“');
      if (i.explanation) lines.push('<b>' + e(L.problem) + ':</b> ' + _docReportText_(i.explanation));
      if (i.evidence) lines.push('<b>' + e(L.evidence) + ':</b> ' + _docReportText_(i.evidence));
      if (i.suggestion && i.suggestion !== '–') lines.push('<b>' + e(L.fix) + ':</b> ' + _docReportText_(i.suggestion));
      out.push('<p><b>☐ <span style="color:' + sv.color + '">' + it.id + '</span> · ' + e(i.location || '') + ' · ' + e(it.title) + '</b></p>');
      out.push('<p style="margin-left:28px">' + lines.join('<br>') + '</p>');
    });
  });

  // 3 Umfassende Erklaerung
  out.push('<h2>3 ' + e(L.explanation) + '</h2><p><i>' + e(L.explanationIntro) + '</i></p>');
  reports.forEach(function(r, i) {
    out.push('<h3>' + e(r.title) + '</h3>');
    if (r.error) { out.push('<p><i>' + e(L.failed) + ': ' + e(r.error) + '</i></p>'); return; }
    if (r.note) out.push('<p><i>' + e(r.note) + '</i></p>');
    out.push(_markdownToHtml_(r.markdown, 2));
    if (r.truncated) out.push('<p><i>' + e(L.truncated) + '</i></p>');
    if (i < reports.length - 1) out.push('<hr>');
  });
  return '<html><head><meta charset="utf-8"></head><body>' + out.join('\n') + '</body></html>';
}

// Womit die Gesamtdokument-Prompts liefen: 'pdf', 'text' (Seitentext statt PDF) oder 'mixed'.
// Ein Bericht mit Vermerk (note) lief mit dem Seitentext.
function _docReportMode_(reports) {
  var ok = (reports || []).filter(function(r) { return r && !r.error; });
  if (!ok.length) return '';
  var text = ok.filter(function(r) { return r.note; }).length;
  return text === 0 ? 'pdf' : (text === ok.length ? 'text' : 'mixed');
}

// Zahlen der Seitenpruefung (Terminologie, Grammatik ...) fuer die Zusammenfassung des Berichts;
// Funde der Gesamtdokument-Prompts (Typ "prompt") zaehlen dort nicht mit.
function _docReportPageChecks_(issues) {
  var counts = {}, order = [];
  (issues || []).forEach(function(i) {
    if (!i || i.type === 'prompt') return;
    var t = i.type || 'style';
    if (!counts.hasOwnProperty(t)) { counts[t] = 0; order.push(t); }
    counts[t]++;
  });
  return order.map(function(t) {
    var label = _ct_('type.' + t);
    return { label: label === 'type.' + t ? t : label, n: counts[t] };
  });
}

// Legt den Bericht als Google Doc an (Drive-Upload mit Umwandlung). Liefert die URL oder ''.
function _buildDocPromptReport_(fileName, reports, folderKey, meta) {
  meta = meta || {};
  if (!reports.some(function(r) { return r.markdown || (r.issues || []).length; })) return '';
  var tz = Session.getScriptTimeZone() || 'Europe/Berlin';
  var fullMeta = {
    language: meta.language, pages: meta.pages, mode: meta.mode, pageChecks: meta.pageChecks,
    date: Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy HH:mm')
  };
  var title = _docReportTitle_(fileName, Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), meta.language);
  var html = _docReportHtml_(fileName, reports, fullMeta);

  var boundary = 'tc' + Utilities.getUuid().replace(/-/g, '');
  var docMeta = { name: title, mimeType: 'application/vnd.google-apps.document', parents: [_tcFolder_(folderKey || 'reports').getId()] };
  var payload = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(docMeta) +
    '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + boundary + '--';
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: Utilities.newBlob(payload, 'multipart/related', 'report').getBytes(),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Report could not be created (HTTP ' + res.getResponseCode() + ').');
  var file = JSON.parse(res.getContentText());
  return file.webViewLink || ('https://docs.google.com/document/d/' + file.id + '/edit');
}

// Berichte erzeugen und Fehler beim Anlegen des Docs nicht die ganze Pruefung
// kippen lassen. Liefert { url, items: [{ title, error, truncated }], notes }.
// notes (optional): Hinweise in der UI-Sprache (siehe _docPromptNotes_).
// meta (optional): { language, pages, mode, pageChecks } fuer Kopfdaten und Zusammenfassung des Berichts.
function _finishDocPromptReports_(fileName, reports, folderKey, notes, meta) {
  var out = { url: '', notes: notes || [], items: reports.map(function(r) {
    return { title: r.title, error: r.error || '', note: r.note || '', truncated: !!r.truncated, findings: (r.issues || []).length };
  }) };
  if (!reports.length) return out;
  try { out.url = _buildDocPromptReport_(fileName, reports, folderKey, meta); }
  catch (e) {
    Logger.log('_finishDocPromptReports_: ' + (e.message || e));
    out.error = e.message || String(e);
  }
  logAuditEvent_(getUserEmail_(), 'DOC_PROMPT_RUN', fileName + ' - ' + reports.length + ' prompt(s), ' +
    reports.filter(function(r) { return r.error; }).length + ' failed');
  return out;
}

// ─── MARKDOWN -> HTML (fuer die Umwandlung in ein Google Doc) ────────────────
// Bewusst klein: Ueberschriften, Listen (verschachtelt per Einrueckung),
// Trennlinien, Tabellen, **fett**, *kursiv*, `code`, [Link](url), Absaetze.
function _mdEsc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _mdInline_(s) {
  var out = _mdEsc_(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  return out;
}

function _markdownToHtml_(md, levelShift) {
  var lines = String(md || '').replace(/\r\n?/g, '\n').replace(/^```[a-z]*\n?|```$/gim, '').split('\n');
  var html = [], para = [], stack = []; // stack: Einrueckungen offener <ul>/<ol>
  function flushPara() { if (para.length) { html.push('<p>' + para.map(_mdInline_).join('<br>') + '</p>'); para = []; } }
  function closeLists(toDepth) { while (stack.length > toDepth) html.push('</' + stack.pop().tag + '>'); }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m;
    if (!line.trim()) { flushPara(); continue; }
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      flushPara(); closeLists(0);
      var lvl = Math.min(6, m[1].length + (levelShift || 0));
      html.push('<h' + lvl + '>' + _mdInline_(m[2].replace(/\s#+\s*$/, '')) + '</h' + lvl + '>');
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeLists(0); html.push('<hr>'); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); closeLists(0);
      var rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      i--;
      html.push('<table border="1" cellpadding="4" style="border-collapse:collapse">' + rows.filter(function(r) {
        return !/^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(r);
      }).map(function(r, ri) {
        var cells = r.trim().replace(/^\||\|$/g, '').split('|');
        var tag = ri === 0 ? 'th' : 'td';
        return '<tr>' + cells.map(function(c) { return '<' + tag + '>' + _mdInline_(c.trim()) + '</' + tag + '>'; }).join('') + '</tr>';
      }).join('') + '</table>');
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      var indent = m[1].replace(/\t/g, '    ').length;
      var tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      while (stack.length && stack[stack.length - 1].indent > indent) html.push('</' + stack.pop().tag + '>');
      if (!stack.length || stack[stack.length - 1].indent < indent) {
        html.push('<' + tag + '>'); stack.push({ indent: indent, tag: tag });
      } else if (stack[stack.length - 1].tag !== tag) {
        html.push('</' + stack.pop().tag + '>'); html.push('<' + tag + '>'); stack.push({ indent: indent, tag: tag });
      }
      html.push('<li>' + _mdInline_(m[3]) + '</li>');
      continue;
    }
    if (stack.length && /^\s+\S/.test(line)) { html.push('<li style="list-style:none">' + _mdInline_(line.trim()) + '</li>'); continue; }
    closeLists(0);
    para.push(line.trim());
  }
  flushPara(); closeLists(0);
  return html.join('\n');
}

// Name der geoeffneten Datei (Docs/Sheets/Slides) fuer Bericht und Prompt-Kontext.
function _activeFileName_() {
  try {
    var f = DocumentApp.getActiveDocument() || SpreadsheetApp.getActiveSpreadsheet() || SlidesApp.getActivePresentation();
    return f ? f.getName() : 'Document';
  } catch (e) {
    return 'Document';
  }
}

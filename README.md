# Kärcher TermCheck

Google-Workspace-Add-on zum Prüfen von Kärcher-Terminologie und Schreibregeln in Docs, Sheets, Slides und Drive.
Findet Fehler mit Gemini, korrigiert direkt im Dokument und kommentiert PDFs.

| | |
|---|---|
| **Typ** | Workspace-Add-on und Web-App (Google Apps Script) |
| **Läuft in** | Google Docs, Sheets, Slides und Drive |
| **Anbindungen** | Phrase TMS (Termbanken), Gemini, Google Drive, Google Sheets |
| **Sprache der Oberfläche** | 15 Sprachen (Standard Englisch), Regeltexte in `RuleTexts_*.js` |

## Funktionen

- **Author Check:** prüft Text auf Grammatik, Terminologie und Stil und schlägt Korrekturen vor.
- **Korrekturen übernehmen** oder als Kommentar ins Dokument setzen, Sprung zur Fundstelle.
- **Terminologiesuche** in den Phrase-Termbanken, auch per Freitext und Bild (Web-App).
- **PDF-Check** in Drive, auch für große PDFs, mit Ergebnis als Sheet oder als kommentierte PDF.
- **Regeln** konfigurieren, eigene KI-Prompt-Regeln anlegen, Regeln exportieren.

## Aufbau

| Datei | Inhalt |
|---|---|
| `Code.js` | Web-App, Einstellungen, Terminologiesuche |
| `Homepage.js`, `CardI18n.js` | Startkarte des Add-ons |
| `Authorcheck.js`, `Rules.js`, `RuleTexts_*.js` | Author Check und Regelwerk |
| `DocPrompts.js` | Prompts, die das ganze Dokument prüfen |
| `DriveAddon.js`, `DrivePdfPrep.js`, `DrivePdfWeb.js` | PDF-Check in Drive |
| `PdfAnnotate.js`, `PdfShrink.js`, `PdfInflate.js`, `PdfTextPosition.js`, `PdfAnnotateSearch.js` | PDF-Verarbeitung ohne Fremdbibliothek (reine Funktionen, laufen auch im Browser) |
| `PdfBrowserApi.js`, `PdfBrowser.html`, `PdfBrowserClient.html`, `PdfWorkerSource.html` | PDF im Browser lesen (Prototyp, siehe unten) |
| `Folders.js` | Ordnerstruktur „Kärcher TermCheck“ im eigenen Drive |
| `*.html` | Oberflächen (Sidebar, Author Check, Terminologiesuche, PDF-Check) |
| `test/`, `tools/` | Node-Tests und Build-Skript für die PDF-Verarbeitung (nicht von clasp hochgeladen) |

## Einrichtung

Script Properties (die meisten auch über die Einstellungen der Web-App für Admins):

| Property | Zweck |
|---|---|
| `ADMIN_EMAILS` | Admins, kommagetrennt |
| `PHRASE_API_TOKEN` | Zugang zu Phrase TMS |
| `ALLOWED_TB_UIDS` | Termbanken, die durchsucht werden |
| `TEMPLATE_LLM`, `TEMPLATE_ALG` | Phrase-Vorlagen für Terminologie-Prüfprojekte |
| `GEMINI_API_KEY`, `GEMINI_API_URL`, `AI_MODEL`, `AI_TEMPERATURE` | Gemini-Anbindung |
| `AI_PROMPT`, `AUTHORCHECK_PROMPT` | eigene Prompts statt der Standard-Prompts |
| `CUSTOM_RULES_LOG_SHEET_ID` | Protokoll für eigene Regeln |
| `WEBAPP_URL` | Adresse der Web-App für den PDF-Check |
| `DOC_PROMPT_PDF_MAX_MB` | Größengrenze für Gesamtdokument-Prompts bei PDFs |

## Entwicklung und Deployment

```
clasp push
```

Danach in Apps Script die Add-on-Bereitstellung und die Web-App-Bereitstellung aktualisieren.

## Tests

| Befehl | Prüft |
|---|---|
| `node test/annotate-flow.cjs` | kompletter Ablauf „kommentierte PDF“ gegen ein simuliertes Drive |
| `node test/pdf-memory.cjs` | Speicherverbrauch der PDF-Verarbeitung |
| `node test/browser-engine.cjs` | PDF-Verarbeitung im Browser (Chromium, Playwright nötig) gegen ein simuliertes Drive, Ergebnis Byte für Byte wie in Apps Script |
| `node tools/build-pdf-worker.cjs --check` | `PdfWorkerSource.html` ist aktuell |
| `GeminiTest.js` (im Editor) | Verbindung zu Gemini |

## Betrieb und Fehlersuche

- Ohne `PHRASE_API_TOKEN` bzw. `GEMINI_API_KEY` zeigt die Oberfläche „nicht verbunden“.
- `exportProjectToTxt` (nur Admins) exportiert den Code als Textdateien nach `EXPORT_FOLDER_ID`.
- Fehler landen in Google Cloud Logging (`exceptionLogging: STACKDRIVER`).

## PDF im Browser (Prototyp)

Sehr große PDFs (200 MB, 3000 Seiten) scheitern in Apps Script an Speicher und Laufzeit, schon beim Öffnen.
Der Prototyp verlagert die PDF-Arbeit in den Browser: Ein Web Worker liest die Datei stückweise per
HTTP-Range direkt aus Drive (mit dem eigenen Token der Person), sortiert Bilder aus, sucht die Fundstellen
und baut den Kommentar-Anhang. Die Kommentare kommen als Incremental Update an das unveränderte Original,
die Bilder werden nicht heruntergerechnet. Die PDF geht nie durch Apps Script.

- **Testseite:** `<Web-App-URL>?page=pdfbrowser` (optional `&fileId=...`). Zeigt jeden Schritt mit Zeit und Menge
  und prüft dabei die Dinge, die sich nur in der echten Umgebung zeigen: Worker startbar, Drive-Zugriff aus dem
  Browser, Download der Datei.
- **Gleicher Code:** Der Worker besteht aus denselben Modulen wie Apps Script (`PdfInflate`, `PdfTextPosition`,
  `PdfAnnotate`, `PdfShrink`, `PdfAnnotateSearch`) plus `tools/pdf-worker-main.txt`. Nach jeder Änderung an einem
  Modul `node tools/build-pdf-worker.cjs` ausführen und `PdfWorkerSource.html` mit einchecken.
- **Noch nicht angeschlossen:** die Prüfung mit Gemini (Pakete vorbereiten kann der Worker schon, `split`).

Gemessen (Chromium, simuliertes Drive mit 100 ms Verzögerung je Anfrage): 205 MB mit 300 Seiten öffnen in ca. 4 s,
3000 Seiten in ca. 3 s; 150 Funde in 3000 Seiten suchen in ca. 13 s. Das Ergebnis ist Byte für Byte gleich wie mit den
Apps-Script-Modulen und öffnet in pypdf.

Nicht in der echten Umgebung geprüft (Testseite zeigt es): Worker aus Blob-URL im Apps-Script-Frame,
CORS-Anfrage mit Token an `www.googleapis.com`, Dateidownload aus dem Frame. Das Token hält Drive-Zugriff ca. eine
Stunde, eine Sitzung länger als das bricht mit einer klaren Meldung ab.

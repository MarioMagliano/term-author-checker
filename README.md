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

## Installation (Testbereitstellung)

1. `clasp push` (oder Code in das Apps-Script-Projekt kopieren) und das Projekt in Apps Script öffnen.
2. **Deploy → Test deployments**.
3. Zahnrad bei **Select type** → **Google Workspace Add-on** wählen (Deployment: *Test latest code*).
4. **Install** → **Done**.
5. Das Add-on erscheint danach in Docs, Sheets, Slides und Drive (Seitenleiste rechts, Logo „Kärcher TermCheck“). Ggf. Seite neu laden.

Danach Script Properties setzen (siehe Einrichtung). Für den Produktivbetrieb: **Deploy → New deployment**.

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
| `node test/rules-page.cjs` | Regel-Popup als eigene Seite (`?page=rules`) im Browser, ohne Docs/Sheets (Playwright nötig) |
| `node test/browser-api.cjs` | Serverseite der Browser-Prüfung (`PdfBrowserApi.js`) mit Platzhaltern für die Apps-Script-Dienste, echter Gemini-Anfrage- und Antwortcode |
| `node test/browser-engine.cjs` | PDF-Verarbeitung im Browser (Chromium, Playwright nötig) gegen ein simuliertes Drive, Ergebnis Byte für Byte wie in Apps Script |
| `node tools/build-pdf-worker.cjs --check` | `PdfWorkerSource.html` ist aktuell |
| `GeminiTest.js` (im Editor) | Verbindung zu Gemini |

## Betrieb und Fehlersuche

- Ohne `PHRASE_API_TOKEN` bzw. `GEMINI_API_KEY` zeigt die Oberfläche „nicht verbunden“.
- `exportProjectToTxt` (nur Admins) exportiert den Code als Textdateien nach `EXPORT_FOLDER_ID`.
- Fehler landen in Google Cloud Logging (`exceptionLogging: STACKDRIVER`).

## English summary

**Kärcher TermCheck** is a Google Workspace add-on (Apps Script) that checks Kärcher terminology and writing rules in Docs, Sheets, Slides and Drive. It uses Gemini to find errors, fixes them in place, and annotates PDFs. Terminology is looked up in Phrase TMS term bases.

### Install (test deployment)

1. Run `clasp push` (or paste the code into the Apps Script project) and open the project.
2. **Deploy → Test deployments**.
3. Click the gear next to **Select type** → choose **Google Workspace Add-on** (deployment: *Test latest code*).
4. Click **Install** → **Done**.
5. The add-on now shows up in the side panel of Docs, Sheets, Slides and Drive. Reload the page if needed.

### Configure

Set the Script Properties listed under *Einrichtung*. At minimum: `ADMIN_EMAILS`, `PHRASE_API_TOKEN`, `GEMINI_API_KEY`. Without the tokens the UI shows "not connected".

### Production

Use **Deploy → New deployment** (Add-on and Web app) and update both after each `clasp push`.

## PDF im Browser (Prototyp)

Sehr große PDFs (200 MB, 3000 Seiten) scheitern in Apps Script an Speicher und Laufzeit, schon beim Öffnen.
Der Prototyp verlagert die PDF-Arbeit in den Browser: Ein Web Worker liest die Datei stückweise per
HTTP-Range direkt aus Drive (mit dem eigenen Token der Person), sortiert Bilder aus, teilt sie in Prüfpakete und
baut am Ende den Kommentar-Anhang. Die Kommentare kommen als Incremental Update an das unveränderte Original,
die Bilder werden nicht heruntergerechnet. Die PDF geht nie durch Apps Script; dorthin gehen nur die kleinen
Prüfpakete (Bilder bis 12 MB je Datei behalten, höchstens 60 Pakete) für Prompt, Regeln und Gemini.

- **Seite:** `<Web-App-URL>?page=pdfbrowser` (optional `&fileId=...&lang=de&parallel=8`; `parallel` = Pakete gleichzeitig bei Gemini, 1 bis 12, Standard 6). Datei und Sprache wählen,
  „Mit Gemini prüfen". Ergebnisliste, „Kommentierte PDF erzeugen" (Download) und „Als Sheet exportieren".
  Mit vorbefülltem Link startet nichts von allein, weil eine Prüfung Gemini-Anfragen kostet.
- **Ablauf:** Datei öffnen → in Pakete teilen → bis zu 6 Pakete gleichzeitig an `apiPdfBrowserCheckPart` (je 3 Versuche;
  scheitert ein Paket, wird es Seite für Seite wiederholt, Seiten ohne Ergebnis werden gemeldet) → Funde ohne
  Doppelte zusammenführen → Protokoll (`DRIVE_PDF_CHECK_RUN`, mit dem Zusatz „browser").
- **Gleicher Code:** Der Worker besteht aus denselben Modulen wie Apps Script (`PdfInflate`, `PdfTextPosition`,
  `PdfAnnotate`, `PdfShrink`, `PdfAnnotateSearch`) plus `tools/pdf-worker-main.txt`. Nach jeder Änderung an einem
  Modul `node tools/build-pdf-worker.cjs` ausführen und `PdfWorkerSource.html` mit einchecken.
- **Regeln als eigene Seite:** `<Web-App-URL>?page=rules` zeigt dasselbe Popup „Rules & Custom Prompts“ wie in Docs, Sheets und Slides, aber in einem Browser-Fenster (Aufruf aus dem Translation-Services-Portal, Reiter [FTS-C]). Die Regeln liegen pro Nutzer, sind also dieselben wie im Add-on.
- **Gesamtdokument-Prompts (z. B. Gems):** laufen parallel zu den Seitenpaketen, je Prompt eine Anfrage über das ganze Dokument (`apiPdfBrowserDocPrompts`). Passt die neu aufgebaute PDF in die Grenze `DOC_PROMPT_PDF_MAX_MB` (Standard 13 MB), geht sie als PDF mit, sonst oder bei einer abgelehnten Anfrage läuft der Prompt mit dem Text aller Seiten (wie im Add-on). Die Funde erscheinen mit dem Namen des Prompts als eigene Kategorie, der Bericht als Google Doc (`apiPdfBrowserDocReport`) ist verlinkt.
- **Filter:** Die Kategorien im Ergebnis (Terminologie, Grammatik, Rechtschreibung, Stil und je ein Chip pro Gesamtdokument-Prompt) sind Schalter. Liste, kommentierte PDF und Sheet nutzen nur die eingeschalteten; die Zahl steht in den Knöpfen.
- **Meldungen:** Hinweise zu ausgeschalteten Prompts erscheinen nicht. Gezeigt werden nur echte Probleme (ein Prompt ist fehlgeschlagen, Seiten ohne Ergebnis).
- **Prompt-Cache:** Der Prompt wird 5 Minuten je Sprache zwischengespeichert (`CacheService`); Regeländerungen
  greifen danach.

Gemessen (Chromium, simuliertes Drive mit 100 ms Verzögerung je Anfrage): Eine PDF mit 205 MB und 300 Seiten
öffnet in ca. 5 s und liest dabei nur ca. 2 MB, weil die Bilder nur angelesen werden (die Struktur kommt in
kleinen Blöcken, die Objekte als parallele Range-Anfragen). 3000 Seiten (122 MB, kleine Bilder) öffnen in ca. 1,5 s;
150 Funde in 3000 Seiten suchen in ca. 12 s. Das Ergebnis ist Byte für Byte gleich wie mit den Apps-Script-Modulen und
öffnet in pypdf. Gegenmessung in der echten Umgebung (CBR-Handbuch, 215 MB, 462 Seiten): Die erste Fassung las
die ganze Datei in 8-MB-Blöcken und brauchte 55 s; deshalb liest der Worker jetzt nur noch die nötigen Bereiche.

Wichtig bei parallelen Anfragen: `fetch(..., { cache: 'no-store' })`. Alle Bereiche haben dieselbe Adresse, der
HTTP-Cache des Browsers reiht Anfragen auf dieselbe Adresse sonst hintereinander ein.

Nicht in der echten Umgebung geprüft (Testseite zeigt es): Worker aus Blob-URL im Apps-Script-Frame,
CORS-Anfrage mit Token an `www.googleapis.com`, Dateidownload aus dem Frame. Das Token hält Drive-Zugriff ca. eine
Stunde, eine Sitzung länger als das bricht mit einer klaren Meldung ab.

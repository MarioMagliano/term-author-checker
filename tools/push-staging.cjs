'use strict';

// Lädt den Code für die Test-Bereitstellung (@HEAD, "Test deployments") hoch, mit dem
// Logo "STAGING" statt des normalen Logos. Das Arbeitsverzeichnis bleibt dabei
// unverändert: der Code wird in einen Temp-Ordner kopiert, dort wird die Logo-Adresse im
// Manifest ersetzt und von dort per "clasp push" hochgeladen.
//
//   node tools/push-staging.cjs
//
// Eigenes STAGING-Apps-Script-Projekt: Die Script-ID steht in der Umgebungsvariable
// STAGING_SCRIPT_ID oder in der Datei .clasp.staging.json (nicht im Repo, siehe .gitignore):
//
//   {"scriptId": "<ID des STAGING-Projekts>"}
//
// Dann geht der Upload in dieses Projekt und nie in das produktive aus .clasp.json.
// Ohne Angabe wird wie früher in das Projekt aus .clasp.json hochgeladen (mit Warnung).
//
// Für die produktive Bereitstellung bleibt alles wie gewohnt: "clasp push" direkt aus dem
// Repo lädt das normale Logo hoch (assets/logo.png), danach "Deploy → New deployment".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://raw.githubusercontent.com/MarioMagliano/term-author-checker/main/assets/';
const PROD_LOGO = BASE + 'logo.png';
const STAGING_LOGO = BASE + 'logo-staging.png';

// Die Dateien, die "clasp push" hochlädt (laut .clasp.json: .js, .gs, .html, Manifest).
function uploadFiles(root) {
  return fs
    .readdirSync(root)
    .filter((f) => f === 'appsscript.json' || /\.(js|gs|html)$/.test(f))
    .sort();
}

function withStagingLogo(text) {
  return text.split(PROD_LOGO).join(STAGING_LOGO);
}

// Script-ID des STAGING-Projekts: Umgebungsvariable, sonst .clasp.staging.json, sonst null.
function stagingScriptId(root, env) {
  const fromEnv = String((env || process.env).STAGING_SCRIPT_ID || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(root, '.clasp.staging.json');
  if (!fs.existsSync(file)) return null;
  const id = String(JSON.parse(fs.readFileSync(file, 'utf8')).scriptId || '').trim();
  return id || null;
}

// Kopiert die Upload-Dateien nach dest und ersetzt dabei das Logo. Gibt die Anzahl der
// ersetzten Stellen zurück. scriptId (optional): Zielprojekt statt dem aus .clasp.json.
function stage(root, dest, scriptId) {
  let replaced = 0;
  for (const f of uploadFiles(root)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    replaced += text.split(PROD_LOGO).length - 1;
    fs.writeFileSync(path.join(dest, f), withStagingLogo(text));
  }
  const clasp = JSON.parse(fs.readFileSync(path.join(root, '.clasp.json'), 'utf8'));
  if (scriptId) clasp.scriptId = scriptId;
  fs.writeFileSync(path.join(dest, '.clasp.json'), JSON.stringify(clasp, null, 2));
  return replaced;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termcheck-staging-'));
  try {
    const scriptId = stagingScriptId(ROOT);
    const replaced = stage(ROOT, tmp, scriptId);
    if (replaced === 0) {
      console.error('Das normale Logo wurde im Manifest nicht gefunden, nichts hochgeladen.');
      process.exitCode = 1;
      return;
    }
    console.log('Staging-Logo an ' + replaced + ' Stelle(n) eingesetzt.');
    console.log(scriptId
      ? 'Ziel: STAGING-Projekt ' + scriptId.slice(0, 6) + '...' + scriptId.slice(-4) + '. Lade hoch ...'
      : 'ACHTUNG: keine STAGING-Script-ID (STAGING_SCRIPT_ID oder .clasp.staging.json), Upload geht in das Projekt aus .clasp.json. Lade hoch ...');
    const r = spawnSync('clasp', ['push', '-f'], { cwd: tmp, stdio: 'inherit', shell: true });
    process.exitCode = r.status === null ? 1 : r.status;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { PROD_LOGO, STAGING_LOGO, uploadFiles, withStagingLogo, stage, stagingScriptId };

if (require.main === module) main();

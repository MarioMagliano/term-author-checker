'use strict';

// Lädt den Code für die Test-Bereitstellung (@HEAD, "Test deployments") hoch, mit dem
// Logo "STAGING" statt des normalen Logos. Das Arbeitsverzeichnis bleibt dabei
// unverändert: der Code wird in einen Temp-Ordner kopiert, dort wird die Logo-Adresse im
// Manifest ersetzt und von dort per "clasp push" hochgeladen.
//
//   node tools/push-staging.cjs
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

// Kopiert die Upload-Dateien nach dest und ersetzt dabei das Logo. Gibt die Anzahl der
// ersetzten Stellen zurück.
function stage(root, dest) {
  let replaced = 0;
  for (const f of uploadFiles(root)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    replaced += text.split(PROD_LOGO).length - 1;
    fs.writeFileSync(path.join(dest, f), withStagingLogo(text));
  }
  fs.copyFileSync(path.join(root, '.clasp.json'), path.join(dest, '.clasp.json'));
  return replaced;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termcheck-staging-'));
  try {
    const replaced = stage(ROOT, tmp);
    if (replaced === 0) {
      console.error('Das normale Logo wurde im Manifest nicht gefunden, nichts hochgeladen.');
      process.exitCode = 1;
      return;
    }
    console.log('Staging-Logo an ' + replaced + ' Stelle(n) eingesetzt. Lade hoch ...');
    const r = spawnSync('clasp', ['push', '-f'], { cwd: tmp, stdio: 'inherit', shell: true });
    process.exitCode = r.status === null ? 1 : r.status;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { PROD_LOGO, STAGING_LOGO, uploadFiles, withStagingLogo, stage };

if (require.main === module) main();

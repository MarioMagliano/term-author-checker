// Prüft tools/push-staging.cjs: Im Repo steht das normale Logo (produktiv), beide Bilder
// liegen in assets/, und der Staging-Push ersetzt die Logo-Adresse, ohne die Quelle zu ändern.
//
//   node test/staging-logo.cjs
//
// Exit code 1, wenn eine Prüfung fehlschlägt.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROD_LOGO, STAGING_LOGO, uploadFiles, withStagingLogo, stage, stagingScriptId } = require('../tools/push-staging.cjs');

const ROOT = path.join(__dirname, '..');
const checks = [];
function check(name, ok, detail) { checks.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : '')); }
function count(text, needle) { return text.split(needle).length - 1; }

const manifestText = fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8');
const manifest = JSON.parse(manifestText);

check('Manifest zeigt auf das normale Logo (produktiv)', manifest.addOns.common.logoUrl === PROD_LOGO, manifest.addOns.common.logoUrl);
check('assets/logo.png und assets/logo-staging.png liegen im Repo',
  fs.existsSync(path.join(ROOT, 'assets', 'logo.png')) && fs.existsSync(path.join(ROOT, 'assets', 'logo-staging.png')));
check('withStagingLogo ersetzt jede Stelle', count(withStagingLogo(PROD_LOGO + ' ' + PROD_LOGO), PROD_LOGO) === 0 &&
  count(withStagingLogo(PROD_LOGO + ' ' + PROD_LOGO), STAGING_LOGO) === 2);

const before = Object.fromEntries(uploadFiles(ROOT).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termcheck-staging-test-'));
try {
  const replaced = stage(ROOT, tmp);
  check('stage ersetzt das Logo im Manifest', replaced >= 1, replaced + ' Stelle(n)');
  const staged = JSON.parse(fs.readFileSync(path.join(tmp, 'appsscript.json'), 'utf8'));
  check('kopiertes Manifest ist gültig und zeigt auf STAGING', staged.addOns.common.logoUrl === STAGING_LOGO);
  check('.clasp.json wurde mitkopiert', fs.existsSync(path.join(tmp, '.clasp.json')));
  check('Quelldateien blieben unverändert',
    uploadFiles(ROOT).every((f) => fs.readFileSync(path.join(ROOT, f), 'utf8') === before[f]));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Eigenes STAGING-Projekt: Script-ID aus Umgebungsvariable oder .clasp.staging.json
const prodId = JSON.parse(fs.readFileSync(path.join(ROOT, '.clasp.json'), 'utf8')).scriptId;
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'termcheck-staging-test-'));
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'termcheck-staging-root-'));
try {
  stage(ROOT, tmp2, 'STAGING_ID_123');
  check('stage setzt die STAGING-Script-ID in .clasp.json (Repo bleibt unverändert)',
    JSON.parse(fs.readFileSync(path.join(tmp2, '.clasp.json'), 'utf8')).scriptId === 'STAGING_ID_123' &&
    JSON.parse(fs.readFileSync(path.join(ROOT, '.clasp.json'), 'utf8')).scriptId === prodId);
  fs.rmSync(tmp2, { recursive: true, force: true }); fs.mkdirSync(tmp2);
  stage(ROOT, tmp2);
  check('ohne STAGING-ID bleibt die ID aus .clasp.json', JSON.parse(fs.readFileSync(path.join(tmp2, '.clasp.json'), 'utf8')).scriptId === prodId);
  check('stagingScriptId: Umgebungsvariable', stagingScriptId(tmp3, { STAGING_SCRIPT_ID: ' abc ' }) === 'abc');
  check('stagingScriptId: nichts gesetzt', stagingScriptId(tmp3, {}) === null);
  fs.writeFileSync(path.join(tmp3, '.clasp.staging.json'), '{"scriptId":"fromfile"}');
  check('stagingScriptId: .clasp.staging.json', stagingScriptId(tmp3, {}) === 'fromfile');
} finally {
  fs.rmSync(tmp2, { recursive: true, force: true });
  fs.rmSync(tmp3, { recursive: true, force: true });
}

process.exit(checks.every(Boolean) ? 0 : 1);

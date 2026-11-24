// Schaltet das Add-on-Logo in appsscript.json zwischen Test- und Produktivbild um.
//
//   node tools/set-logo.cjs staging   Test-Bereitstellung: Logo mit rotem "STAGING"
//   node tools/set-logo.cjs prod      produktive Add-on-Bereitstellung: normales Logo
//
// Danach wie gewohnt "clasp push". Ohne Argument wird nur der aktuelle Stand angezeigt.
const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/MarioMagliano/term-author-checker/main/assets/';
const LOGOS = { prod: BASE + 'logo.png', staging: BASE + 'logo-staging.png' };
const file = path.join(__dirname, '..', 'appsscript.json');
const text = fs.readFileSync(file, 'utf8');

const current = Object.keys(LOGOS).find((k) => text.includes('"logoUrl": "' + LOGOS[k] + '"'));
const target = process.argv[2];

if (!target) {
  console.log('Aktuelles Logo: ' + (current || 'unbekannt (logoUrl zeigt auf eine andere Adresse)'));
  process.exit(0);
}
if (!LOGOS[target]) {
  console.error('Unbekannter Modus "' + target + '". Erlaubt: staging, prod');
  process.exit(1);
}
if (!current) {
  console.error('logoUrl in appsscript.json hat keinen bekannten Wert, nichts geändert.');
  process.exit(1);
}
if (current === target) {
  console.log('Bereits auf "' + target + '".');
  process.exit(0);
}
fs.writeFileSync(file, text.replace('"logoUrl": "' + LOGOS[current] + '"', '"logoUrl": "' + LOGOS[target] + '"'));
console.log('Logo umgestellt: ' + current + ' -> ' + target + '. Jetzt "clasp push".');

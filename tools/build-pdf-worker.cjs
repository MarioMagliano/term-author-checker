// Baut PdfWorkerSource.html: den Quelltext des Browser-Workers (PDF-Module aus
// Apps Script + tools/pdf-worker-main.txt) als <script type="text/plain">, den
// PdfBrowser.html per include() einbettet und zur Laufzeit als Web Worker startet.
//
//   node tools/build-pdf-worker.cjs          schreibt PdfWorkerSource.html
//   node tools/build-pdf-worker.cjs --check  Exit 1, wenn die Datei veraltet ist
//
// Nach jeder Änderung an einem der Module ausführen und das Ergebnis einchecken.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = ['PdfInflate.js', 'PdfTextPosition.js', 'PdfAnnotate.js', 'PdfShrink.js', 'PdfAnnotateSearch.js'];
const GLUE = path.join(__dirname, 'pdf-worker-main.txt');
const OUT = path.join(ROOT, 'PdfWorkerSource.html');

function workerSource() {
  const parts = MODULES.map(function(f) {
    return '// ---- ' + f + ' ----\n' + fs.readFileSync(path.join(ROOT, f), 'utf8');
  });
  parts.push('// ---- pdf-worker-main ----\n' + fs.readFileSync(GLUE, 'utf8'));
  return parts.join('\n');
}

function build() {
  const src = workerSource();
  // In einem <script>-Block würden diese Folgen den HTML-Parser stören.
  ['</script', '<!--', '<script'].forEach(function(bad) {
    if (src.toLowerCase().indexOf(bad) !== -1) throw new Error('Worker source contains "' + bad + '".');
  });
  return '<!-- Erzeugt von tools/build-pdf-worker.cjs - nicht von Hand ändern. -->\n' +
    '<script type="text/plain" id="pdf-worker-src">\n' + src + '\n</script>\n';
}

module.exports = { workerSource: workerSource, build: build, OUT: OUT };

if (require.main === module) {
  const html = build();
  if (process.argv.indexOf('--check') !== -1) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== html) { console.error('PdfWorkerSource.html ist veraltet: node tools/build-pdf-worker.cjs'); process.exit(1); }
    console.log('PdfWorkerSource.html ist aktuell.');
  } else {
    fs.writeFileSync(OUT, html);
    console.log('PdfWorkerSource.html geschrieben (' + Math.round(html.length / 1024) + ' KB).');
  }
}

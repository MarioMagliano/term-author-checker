// Opens the rules popup page (AuthorCheck.html in rules-only mode, served as ?page=rules) in
// Chromium the way the Translation Services portal opens it: as its own browser window, without
// Docs/Sheets around it (so no google.script.host). Apps Script is simulated.
//
//   node test/rules-page.cjs
//
// Needs Playwright; without it the test is skipped. Exit code 1 if a check fails.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const checks = [];
function check(name, ok, detail) { checks.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : '')); }

(async function main() {
  let playwright;
  try { playwright = require('playwright'); } catch (e) { console.log('skipped: Playwright is not installed.'); return; }

  const i18n = fs.readFileSync(path.join(ROOT, 'I18n.html'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'AuthorCheck.html'), 'utf8')
    .replace("<?= rulesOnly ? 'popup-mode rules-only' : '' ?>", 'popup-mode rules-only')
    .replace('<?!= JSON.stringify(uiLang) ?>', function() { return JSON.stringify('de'); })
    .replace('<?!= JSON.stringify(hostApp) ?>', function() { return JSON.stringify('web'); })
    .replace('<?!= JSON.stringify(!!rulesOnly) ?>', 'true')
    .replace("<?!= include('I18n'); ?>", function() { return i18n; });
  check('no template placeholders left in the page', html.indexOf('<?') === -1);

  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('https://app.test/', function(route) { route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }); });
  const page = await ctx.newPage();
  const errors = [], calls = [];
  page.on('pageerror', function(e) { errors.push(e.message); });
  await page.exposeFunction('__srv', function(name, args) {
    calls.push(name);
    if (name === 'apiGetContext') return { aiEnabled: true, isAdmin: true, rulesHelpSeen: true, email: 'tim@example.com' };
    if (name === 'apiGetRulesConfig') return [];
    return null;
  });
  await page.addInitScript(function() {
    window.__closed = 0;
    window.close = function() { window.__closed++; };
    // google.script.run.withSuccessHandler(f).withFailureHandler(g).apiXyz(args...); google.script.host does not exist.
    function runner(ok, bad) {
      return new Proxy({}, { get: function(t, name) {
        if (name === 'withSuccessHandler') return function(f) { return runner(f, bad); };
        if (name === 'withFailureHandler') return function(f) { return runner(ok, f); };
        return function() { window.__srv(name, Array.prototype.slice.call(arguments)).then(function(r) { if (ok) ok(r); }, function(e) { if (bad) bad(e); }); };
      } });
    }
    window.google = { script: { run: runner(null, null) } };
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('https://app.test/');
  await page.waitForTimeout(800);

  check('rules dialog is open, as in the popup', await page.$eval('#rulesModal', function(n) { return n.classList.contains('open'); }));
  check('the editor surface behind it is hidden (rules-only)', await page.$eval('#app', function(n) { return getComputedStyle(n).display === 'none'; }));
  check('rules and context were loaded', calls.indexOf('apiGetRulesConfig') !== -1 && calls.indexOf('apiGetContext') !== -1, calls.join(', '));
  check('no script errors without google.script.host', errors.length === 0, errors.join(' | '));
  await page.click('#rulesModal .modal-close');
  await page.waitForTimeout(200);
  check('the close button closes the window instead of failing', (await page.evaluate(function() { return window.__closed; })) === 1 && errors.length === 0, errors.join(' | '));
  await browser.close();

  const ok = checks.every(Boolean);
  console.log(ok ? 'OK' : 'FAILED');
  process.exit(ok ? 0 : 1);
})().catch(function(e) { console.error(e); process.exit(1); });

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const vm = require('vm');
const fs = require('fs'), path = require('path');
const { load } = require('./postman-helpers');
const fx = require('./postman-fixtures');

// ---------- request status ----------
test('a request that never completed is an ERROR, listed under Failed, and fails the run', () => {
  const p = load().render(fx.newman);
  assert.equal(p.badge('Health check (server down)'), 'ERROR');
  assert.ok(p.cards('testResultsFailed').some(c => c.textContent.includes('Health check')));
  assert.match(p.card('Health check (server down)').textContent, /connect ECONNREFUSED/);
});
test('a run whose only request failed to connect is never reported as PASS', () => {
  const only = JSON.parse(JSON.stringify(fx.newman));
  only.run.executions = [only.run.executions[2]];
  const p = load().render(only);
  assert.notEqual(p.overall(), 'PASS');
  assert.notEqual(p.overall(), 'NO DATA');
});
test('requests without tests are NO TESTS and not counted as passed', () => {
  const p = load().render(fx.newman);
  assert.equal(p.badge('No tests written'), 'NO TESTS');
  assert.ok(!p.cards('testResultsPassed').some(c => c.textContent.includes('No tests written')));
  assert.match(p.notices(), /no tests/);
});
test('skipped assertions are SKIPPED, not passed', () => {
  const p = load().render(fx.newman);
  assert.equal(p.badge('Skipped checks'), 'SKIPPED');
  assert.match(p.text('totalAssertions'), /skipped/);
});
test('failed assertion messages are shown on the card', () => {
  const p = load().render(fx.newman);
  assert.match(p.card('Create order').textContent, /expected response to have status code 201 but got 500/);
});
test('execution time is the wall-clock time of the run when known', () => {
  assert.equal(load().render(fx.newman).text('executionTime'), '9.00s');
});

// ---------- capture ----------
test('Newman bodies are decoded and request bodies captured', () => {
  const t = load().render(fx.newman).tests;
  assert.equal(t[0].responseBody, '{"id":1,"name":"Pen"}');
  assert.match(t[1].requestBody, /"sku":"A1"/);
  assert.equal(t[2].responseBody, '');
});
test('request and response headers are captured', () => {
  const t = load().render(fx.newman).tests;
  assert.deepEqual(t[0].requestHeaders.map(h => h.key), ['Content-Type', 'Authorization']);
  assert.equal(t[0].contentType, 'application/json');
});
test('folder and iteration are captured and shown', () => {
  const p = load().render(fx.newman);
  assert.equal(p.tests[1].folder, 'Orders');
  assert.equal(p.tests[6].iteration, 2);
  assert.match(p.card('Create order').textContent, /Orders/);
  assert.match(p.cards('testResultsAll')[6].textContent, /Iteration 2/);
});
test('the viewer shows headers, bodies, size and the request error', () => {
  const p = load().render(fx.newman);
  p.open(1);
  assert.match(p.text('requestBodyContent'), /"sku": "A1"/);
  assert.match(p.text('responseHeadersBody'), /Content-Type/);
  assert.match(p.text('detailSummary'), /POST .*orders.*500/);
  assert.match(p.text('responseBodyMeta'), /\d+ B/);
  p.open(2);
  assert.equal(p.d.getElementById('detailError').classList.contains('d-none'), false);
  assert.match(p.text('detailError'), /ECONNREFUSED/);
  assert.match(p.text('responseBodyContent'), /did not complete/);
});
test('huge bodies are shortened for display but kept whole for copy and download', () => {
  const big = JSON.parse(JSON.stringify(fx.newman));
  big.run.executions[0].response.stream = { type: 'Buffer', data: [...Buffer.from('x'.repeat(300000))] };
  const p = load().render(big);
  p.open(0);
  assert.match(p.text('responseBodyContent'), /shortened for display/);
  assert.ok(p.text('responseBodyContent').length < 210000);
  assert.equal(p.ev('currentDetail.responseBody.length'), 300000);
});
test('Postman app exports: legacy raw body and text headers are captured', () => {
  const t = load().render(fx.postmanApp).tests;
  assert.match(t[0].requestBody, /"user":"a"/);
  assert.deepEqual(t[0].requestHeaders.map(h => h.key), ['Content-Type', 'Authorization']);
  assert.equal(t[0].responseBody, '{"token":"t"}');
});
test('a file with no bodies explains how to get them', () => {
  const p = load().render(fx.noBodies);
  assert.match(p.notices(), /no request or response bodies/);
  assert.match(p.notices(), /--reporter-json-structure newman/);
});

// ---------- input handling ----------
test('unsupported JSON gives guidance that mentions the Postman CLI option', () => {
  const p = load(); p.render({ summary: {} });
  assert.match(p.alerts[0], /reporter-json-structure newman/);
});
test('a .json file with an empty MIME type is accepted', async () => {
  const p = load();
  p.w.__f = new p.w.File([JSON.stringify(fx.newman)], 'run.json', { type: '' });
  p.ev('handleFile(window.__f)');
  for (let i = 0; i < 100 && !p.cards('testResultsAll').length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(p.cards('testResultsAll').length, 7);
});

// ---------- secrets and export safety ----------
test('masking hides passwords, tokens and keys in JSON, text, URLs and headers', () => {
  const p = load();
  assert.doesNotMatch(p.ev('maskText(\'{"user":"a","password":"hunter2","nested":{"api_key":"k"}}\')'), /hunter2|"k"/);
  assert.doesNotMatch(p.ev('maskText("token=abc123&x=1")'), /abc123/);
  assert.doesNotMatch(p.ev('maskText("Authorization: Bearer abc.def")'), /abc\.def/);
  assert.match(p.ev('maskUrl("https://x.test/a?api_key=SECRET&page=2")'), /api_key=\*+&page=2/);
  assert.equal(p.ev('maskHeader({ key: "Cookie", value: "s=1" }).value'), '******');
  assert.equal(p.ev('maskText(\'{"author":"Ann"}\')').includes('Ann'), true);
});
test('export data masks secrets by default and can drop bodies entirely', () => {
  const p = load().render(fx.newman);
  assert.doesNotMatch(JSON.stringify(p.ev('prepareExportTests()')), /hunter2|SECRET-TOKEN/);
  p.set('includeBodiesToggle', false);
  const t = p.ev('prepareExportTests()');
  assert.equal(t[1].requestBody, ''); assert.equal(t[1].requestHeaders.length, 0);
});
test('safeJson cannot be broken out of by </script> in a body', () => {
  const p = load();
  const out = p.ev('safeJson({ b: "</script><script>alert(1)</script>" })');
  assert.doesNotMatch(out, /</);
  assert.equal(JSON.parse(out).b, '</script><script>alert(1)</script>');
});
test('HTML export is self-contained: scripts inlined, data intact, no injection', async () => {
  const p = load().render(fx.newman);
  const html = await p.exportHtml();
  const doc = new JSDOM(html).window.document;                       // parse only, scripts are not run
  const scripts = [...doc.querySelectorAll('script')];
  assert.ok(scripts.every(s => !s.getAttribute('src') || /^https?:/.test(s.getAttribute('src')) === false), 'no external script left');
  assert.ok(scripts.some(s => s.textContent.includes('function openTestDetail')), 'app.js is inlined');
  assert.ok(!scripts.some(s => s.textContent.includes('alert(1)') && !s.textContent.includes('testsById')), 'no injected script');
  const data = scripts.find(s => s.textContent.includes('window.testsById ='));
  const sandbox = { window: {} }; vm.runInNewContext(data.textContent, sandbox);
  assert.equal(Object.keys(sandbox.window.testsById).length, 7);
  assert.match(sandbox.window.testsById[5].responseBody, /alert\(1\)/);        // body preserved as text
  assert.doesNotMatch(html, /hunter2|SECRET-TOKEN-123/);                       // masked by default
  assert.equal(doc.querySelector('#rt-bar'), null);
  assert.equal(doc.querySelector('#jsonUploadArea'), null);
});

// ---------- PDF (print) ----------
const fire = (p, name) => p.w.dispatchEvent(new p.w.Event(name));

test('Export PDF opens the print flow with a useful file name and hint, then restores the title', () => {
  const p = load().render(fx.newman);
  const before = p.d.title;
  p.ev('exportReportToPDF()');
  assert.equal(p.w.__printed, 1);
  assert.match(p.w.__titleWhilePrinting, /^Postman report - Shop API - \d{4}-\d{2}-\d{2}$/);
  assert.equal(p.d.getElementById('pdfHint').classList.contains('d-none'), false);
  fire(p, 'afterprint');
  assert.equal(p.d.title, before);
});
test('charts are swapped for images while printing and restored afterwards', () => {
  const p = load().render(fx.newman);
  fire(p, 'beforeprint');
  assert.equal(p.d.querySelectorAll('.print-img').length, 2);
  assert.equal(p.d.querySelectorAll('.chart-container.has-img').length, 2);
  fire(p, 'afterprint');
  assert.equal(p.d.querySelectorAll('.print-img').length, 0);
  assert.equal(p.d.querySelectorAll('.has-img').length, 0);
});
test('printing always uses the light theme, then returns to the chosen theme', () => {
  const p = load().render(fx.newman);
  p.d.documentElement.setAttribute('data-bs-theme', 'dark');
  fire(p, 'beforeprint');
  assert.equal(p.d.documentElement.getAttribute('data-bs-theme'), 'light');
  assert.ok(p.d.documentElement.classList.contains('printing'));
  fire(p, 'afterprint');
  assert.equal(p.d.documentElement.getAttribute('data-bs-theme'), 'dark');
  assert.ok(!p.d.documentElement.classList.contains('printing'));
});
test('printing before a report is loaded does nothing', () => {
  const p = load();
  fire(p, 'beforeprint');
  assert.ok(!p.d.documentElement.classList.contains('printing'));
});
test('loading a second report replaces the charts instead of stacking them', () => {
  const p = load().render(fx.newman).render(fx.postmanApp);
  assert.equal(p.ev('reportCharts.length'), 2);
  assert.equal(p.w.__destroyed, 2);
});
test('the screenshot-based PDF libraries are gone', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'postman.html'), 'utf8'), app = fs.readFileSync(path.join(root, 'script', 'app.js'), 'utf8');
  assert.doesNotMatch(html + app, /html2canvas|jspdf/i);
});
test('print styles keep cards whole, hide controls and print only the active tab', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
  const print = css.slice(css.lastIndexOf('@media print'));
  assert.match(print, /\.test-card[^{]*\{[^}]*break-inside: avoid/);
  assert.match(print, /\.tab-content > \.tab-pane \{ display: none/);
  assert.match(print, /\.tab-content > \.tab-pane\.active \{ display: block/);
  assert.match(print, /\.chart-container\.has-img canvas \{ display: none/);
  assert.match(print, /#rt-bar/);
});

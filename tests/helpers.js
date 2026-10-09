// Loads the real jmeter.html in jsdom, feeds it CSV text, and exposes what the page rendered.
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path'), vm = require('vm');
const Papa = require('papaparse');

const HTML = process.env.JMETER_HTML || path.join(__dirname, '..', 'jmeter.html');

async function run(csv, { type = 'auto', fileName = 'run.jtl' } = {}) {
  const html = fs.readFileSync(HTML, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.Papa = { parse: (file, cfg) => Papa.parse(file.__text !== undefined ? file.__text : csv, { ...cfg, worker: false }) };
  w.Chart = function (el) { this.canvas = el; this.destroy = () => {}; this.resize = () => {}; this.toBase64Image = () => 'data:image/png;base64,AAAA'; };
  w.URL.createObjectURL = () => 'blob:test';
  const ctx = dom.getInternalVMContext();
  vm.runInContext(script, ctx);
  d.getElementById('type').value = type;
  w.__file = new w.File([csv], fileName); w.__file.__text = csv;
  vm.runInContext('parse(window.__file)', ctx);
  for (let i = 0; i < 200; i++) {                     // wait until a report or an error appears
    if (!d.getElementById('out').hidden || !d.getElementById('msg').classList.contains('d-none')) break;
    await new Promise(res => setTimeout(res, 25));
  }
  const q = s => d.querySelector(s);
  const page = {
    d, w,
    get R() { return vm.runInContext('R', ctx); },
    rendered: () => !d.getElementById('out').hidden,
    error: () => d.getElementById('msg').classList.contains('d-none') ? '' : d.getElementById('msg').textContent,
    status: () => ['pass', 'warn', 'fail'].find(s => q('#out .overall-status').classList.contains(s)),
    typeLabel: () => d.getElementById('metaType').textContent,
    note: () => (q('#out .overall-status .text-muted.small') || {}).textContent || '',
    rules: () => [...d.querySelectorAll('#out .chip-row .badge')].map(el => ({ text: el.textContent, status: ['pass', 'warn', 'fail'].find(s => el.classList.contains('pill-' + s)) })),
    rule: name => page.rules().find(r => r.text.startsWith(name)),
    card: title => [...d.querySelectorAll('#out .summary-card')].find(c => c.textContent.includes(title)),
    set: (id, value) => { const el = d.getElementById(id); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    hasBaseline: () => vm.runInContext('!!BASE', ctx),
    async addBaseline(text, name = 'baseline.jtl') {
      const f = new w.File([text], name); f.__text = text; w.__base = f;
      vm.runInContext('loadBaseline(window.__base)', ctx);
      for (let i = 0; i < 200; i++) { if (page.hasBaseline() || page.error()) break; await new Promise(res => setTimeout(res, 25)); }
      return page;
    },
    clearBaseline: () => vm.runInContext('clearBaseline()', ctx),
    cmp: (tol = 10) => vm.runInContext('compareRuns(R, BASE, ' + tol + ')', ctx),
    standalone: () => vm.runInContext('buildStandaloneHtml()', ctx),
  };
  return page;
}
module.exports = { run };

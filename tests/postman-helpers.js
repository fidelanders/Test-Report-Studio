// Loads the real postman.html + script/app.js in jsdom.
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');

function load() {
  const html = fs.readFileSync(path.join(ROOT, 'postman.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'script', 'app.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window, d = w.document, alerts = [];
  w.alert = m => alerts.push(m);
  w.TextDecoder = TextDecoder; w.URL.revokeObjectURL = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }) }; };
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
  w.HTMLAnchorElement.prototype.click = () => {};
  w.__destroyed = 0; w.__printed = 0;
  w.Chart = function (ctx2d) { this.canvas = ctx2d.canvas; this.destroy = () => { w.__destroyed++; }; this.resize = () => {}; this.toBase64Image = () => 'data:image/png;base64,AAAA'; };
  w.print = () => { w.__printed++; w.__titleWhilePrinting = d.title; };
  w.bootstrap = { Modal: function () { this.show = () => {}; }, Tab: function () { this.show = () => {}; } };
  const ctx = dom.getInternalVMContext();
  vm.runInContext(app, ctx);
  const ev = (code) => vm.runInContext(code, ctx);
  const page = {
    w, d, ctx, alerts, ev,
    render: json => { w.__json = json; ev('renderReport(window.__json)'); return page; },
    get tests() { return JSON.parse(JSON.stringify(ev('allTests'))); },
    cards: tab => [...d.querySelectorAll('#' + tab + ' .test-card')],
    card: name => [...d.querySelectorAll('#testResultsAll .test-card')].find(c => c.querySelector('.test-name').textContent === name),
    badge: name => page.card(name).querySelector('.test-status').textContent,
    overall: () => d.getElementById('overallStatusBadge').textContent,
    text: id => d.getElementById(id).textContent,
    notices: () => d.getElementById('runNotices').textContent,
    open: id => ev('openTestDetail(' + id + ')'),
    set: (id, v) => { d.getElementById(id).checked = v; },
    async exportHtml() {
      let blob = null;
      w.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
      w.fetch = async url => {
        const u = new URL(url);
        if (u.hostname === 'localhost') { const f = path.join(ROOT, decodeURIComponent(u.pathname)); return { ok: fs.existsSync(f), status: 200, text: async () => fs.readFileSync(f, 'utf8') }; }
        return { ok: true, status: 200, text: async () => '/* cdn */' };
      };
      w.__t = null; await ev('exportReportToHTML()');
      return new Promise(res => { const r = new w.FileReader(); r.onload = () => res(r.result); r.readAsText(blob); });
    },
  };
  return page;
}
module.exports = { load };

/* Report-type registry + selector bar for the tool pages.
   To add a tool (k6, Gatling...): add one entry below, create its page, add a card on index.html. */
(function () {
  var TYPES = [
    { id: 'postman', label: 'Postman report', hint: '.json', href: 'postman.html', accent: '#FF6C37' },
    { id: 'jmeter', label: 'JMeter report', hint: '.csv / .jtl', href: 'jmeter.html', accent: '#8E44AD' }
    // { id: 'k6', label: 'k6 report', hint: '.json', href: 'k6.html', accent: '#7D64FF' }
  ];
  window.REPORT_TYPES = TYPES;
  var strip = function (s) { return s.replace('.html', ''); };
  var file = strip(location.pathname.split('/').pop() || 'index.html');
  var cur = TYPES.find(function (t) { return strip(t.href) === file; }) || TYPES[0];

  var css = document.createElement('style');
  css.textContent =
    '#rt-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;margin:0 0 4px;border-radius:12px;background:var(--card-bg,#fff);border:1px solid var(--border,#dee2e6);font:14px system-ui,sans-serif}' +
    '#rt-bar a{color:var(--text,#212529);text-decoration:none;padding:6px 12px;border-radius:8px;border:1px solid var(--border,#dee2e6);transition:transform .15s}' +
    '#rt-bar a:hover{transform:translateY(-2px)}#rt-bar small{opacity:.6;margin-left:6px}' +
    '#rt-bar a[aria-current]{color:#fff;font-weight:600}#rt-bar .rt-home{margin-right:6px}' +
    '@media print{#rt-bar{display:none!important}}';
  document.head.appendChild(css);

  var bar = document.createElement('nav');
  bar.id = 'rt-bar';
  bar.setAttribute('aria-label', 'Report type');
  bar.innerHTML = '<a class="rt-home" href="index.html" title="Back to home">🏠 Home</a>' + TYPES.map(function (t) {
    var on = t.id === cur.id;
    return '<a href="' + t.href + '"' + (on ? ' aria-current="page" style="background:' + t.accent + ';border-color:' + t.accent + '"' : ' style="border-color:' + t.accent + '55"') + '>' +
      t.label + '<small>' + t.hint + '</small></a>';
  }).join('');
  document.body.insertBefore(bar, document.body.firstChild);
})();

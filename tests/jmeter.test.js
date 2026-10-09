const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const fx = require('./fixtures');

// ---------- load / performance ----------
test('load: a clean run passes', async () => {
  const p = await run(fx.load(), { type: 'load' });
  assert.equal(p.status(), 'pass');
});
test('load: 3% errors is a warning (1% pass, 5% warn)', async () => {
  const p = await run(fx.load({ err: 0.03 }), { type: 'load' });
  assert.equal(p.rule('Error rate').status, 'warn');
  assert.equal(p.status(), 'warn');
});
test('load: 10% errors fails', async () => {
  const p = await run(fx.load({ err: 0.10 }), { type: 'load' });
  assert.equal(p.status(), 'fail');
});
test('load: slow responses warn on p95 but not p99', async () => {
  const p = await run(fx.load({ mean: 1000 }), { type: 'load' });
  assert.equal(p.rule('p95').status, 'warn');
  assert.equal(p.rule('p99').status, 'pass');
});
test('load: editing a threshold re-grades the report', async () => {
  const p = await run(fx.load(), { type: 'load' });
  assert.equal(p.status(), 'pass');
  p.set('tP95', '100');
  assert.equal(p.rule('p95').status, 'fail');
  assert.equal(p.status(), 'fail');
});

// ---------- spike ----------
test('spike: auto-detected', async () => {
  assert.match((await run(fx.spike())).typeLabel(), /spike.*auto-detected/);
});
test('spike: a healthy surge that recovers passes, and recovery is measured', async () => {
  const p = await run(fx.spike({ spikeErr: 0.005, spikeMean: 900, recoverSec: 60 }), { type: 'spike' });
  const rec = p.rule('Recovery');
  assert.equal(rec.status, 'pass');
  assert.doesNotMatch(rec.text, /Not recovered|No data/);
  assert.equal(p.status(), 'pass');
});
test('spike: errors during the surge are not hidden by a calm run', async () => {
  // whole-run error rate is under 2%, but 8% of requests fail during the surge
  const p = await run(fx.spike({ spikeErr: 0.08 }), { type: 'spike' });
  assert.equal(p.rule('Error rate (during spike)').status, 'fail');
  assert.equal(p.status(), 'fail');
});
test('spike: latency that never returns to baseline fails recovery', async () => {
  const p = await run(fx.spike({ spikeErr: 0.005, recoverSec: 0 }), { type: 'spike' });
  assert.match(p.rule('Recovery').text, /Not recovered/);
  assert.equal(p.rule('Recovery').status, 'fail');
});
test('spike: recovery uses a real baseline, not 0 ms', async () => {
  const p = await run(fx.spike({ spikeErr: 0.005, spikeMean: 900, recoverSec: 60 }), { type: 'spike' });
  const base = Number((p.note().match(/~(\d+) ms/) || [])[1]);
  assert.ok(base > 150 && base < 500, 'baseline p95 was ' + base);
});

// ---------- soak ----------
test('soak: runs over two hours are auto-detected', async () => {
  assert.match((await run(fx.soak())).typeLabel(), /soak.*auto-detected/);
});
test('soak: latency that keeps growing fails on drift', async () => {
  const p = await run(fx.soak({ drift: 0.6 }), { type: 'soak' });
  const drift = Number((p.rule('Latency drift').text.match(/\+([\d.]+)%/) || [])[1]);
  assert.ok(drift > 30, 'drift was ' + drift);
  assert.equal(p.rule('Latency drift').status, 'fail');
  assert.equal(p.status(), 'fail');
});
test('soak: flat latency passes', async () => {
  const p = await run(fx.soak({ drift: 0 }), { type: 'soak' });
  assert.equal(p.rule('Latency drift').status, 'pass');
  assert.equal(p.status(), 'pass');
});

// ---------- stress ----------
test('stress: auto-detected', async () => {
  assert.match((await run(fx.stress())).typeLabel(), /stress.*auto-detected/);
});
test('stress: ~26% errors is a warning and the breaking point is reported', async () => {
  const p = await run(fx.stress({ lateErr: 0.45 }), { type: 'stress' });
  assert.equal(p.rule('Error rate (whole run)').status, 'warn');
  assert.match(p.rule('Breaking point').text, /~\d+ users/);
  assert.equal(p.status(), 'warn');
});
test('stress: more than 40% errors fails', async () => {
  const p = await run(fx.stress({ lateErr: 0.9 }), { type: 'stress' });
  assert.equal(p.status(), 'fail');
});
test('stress: a system that copes reports no breaking point and passes', async () => {
  const p = await run(fx.stress({ lateErr: 0, slope: 2 }), { type: 'stress' });
  assert.match(p.rule('Breaking point').text, /Not reached/);
  assert.equal(p.status(), 'pass');
});

// ---------- parsing and numbers ----------
test('rejects a file without a JMeter header row', async () => {
  const p = await run('hello,world\n1,2\n');
  assert.equal(p.rendered(), false);
  assert.match(p.error(), /JMeter CSV/);
});
test('p95 is within 2% of the exact value', async () => {
  const p = await run(fx.uniform(), { type: 'load' });
  assert.ok(Math.abs(p.R.tot.p95 - 955) < 955 * 0.02, 'p95 was ' + p.R.tot.p95);
});
test('a 30-hour file keeps the timeline bounded and still renders', async () => {
  const p = await run(fx.soak({ drift: 0.5, rows: 108000 }));
  assert.ok(p.R.tl.length <= 100, 'timeline had ' + p.R.tl.length + ' points');
  assert.match(p.typeLabel(), /soak/);
});

// ---------- what failed ----------
test('What Failed names the endpoint and the error', async () => {
  const p = await run(fx.load({ err: 0.05 }), { type: 'load' });
  const text = p.card('What Failed').textContent;
  assert.match(text, /POST \/pay/);
  assert.match(text, /503 · Service Unavailable/);
});

// ---------- standalone HTML export ----------
test('HTML export is a self-contained page with the verdict and chart images', async () => {
  const p = await run(fx.load({ err: 0.10 }), { type: 'load', fileName: 'a<b>.jtl' });
  const html = p.standalone();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /FAILED/);
  assert.match(html, /data:image\/png/);
  assert.doesNotMatch(html, /<canvas|<script/);
  assert.match(html, /a&lt;b&gt;\.jtl/);
  assert.doesNotMatch(html, /a<b>/);
});

// ---------- baseline comparison ----------
const row = (cmp, name) => cmp.rows.find(r => r.name === name);

test('baseline: an identical run shows no change', async () => {
  const p = await (await run(fx.load(), { type: 'load' })).addBaseline(fx.load());
  const c = p.cmp();
  assert.ok(c.rows.every(r => r.status === 'same'));
  assert.equal(p.rule('p95 vs baseline').status, 'pass');
  assert.equal(p.rule('Error rate vs baseline').status, 'pass');
  assert.ok(p.card('Compared with baseline'));
});
test('baseline: a regression fails even when the absolute limits still pass', async () => {
  const p = await (await run(fx.load({ mean: 420 }), { type: 'load' })).addBaseline(fx.load());
  assert.equal(p.rule('p95').status, 'pass');                    // 486 ms is under the 800 ms limit
  assert.equal(p.rule('p95 vs baseline').status, 'fail');        // but it is >25% slower than the baseline
  assert.equal(p.status(), 'fail');
});
test('baseline: a moderate slowdown warns', async () => {
  const p = await (await run(fx.load({ mean: 360 }), { type: 'load' })).addBaseline(fx.load());
  assert.equal(p.rule('p95 vs baseline').status, 'warn');
  assert.equal(p.status(), 'warn');
});
test('baseline: a faster run is reported as better', async () => {
  const p = await (await run(fx.load({ mean: 240 }), { type: 'load' })).addBaseline(fx.load());
  const c = p.cmp();
  assert.equal(c.metrics.find(m => m.key === 'p95').v, 'better');
  assert.ok(c.rows.every(r => r.status === 'better'));
  assert.equal(p.status(), 'pass');
});
test('baseline: more errors are flagged', async () => {
  const p = await (await run(fx.load({ err: 0.02 }), { type: 'load' })).addBaseline(fx.load());
  assert.equal(p.rule('Error rate vs baseline').status, 'warn');
  const bad = await (await run(fx.load({ err: 0.08 }), { type: 'load' })).addBaseline(fx.load());
  assert.equal(bad.rule('Error rate vs baseline').status, 'fail');
});
test('baseline: only the endpoint that got slower is marked as a regression', async () => {
  const p = await (await run(fx.loadPay({ payMean: 500 }), { type: 'load' })).addBaseline(fx.loadPay());
  const c = p.cmp();
  assert.equal(row(c, 'POST /pay').status, 'worse');
  assert.equal(row(c, 'GET /cart').status, 'same');
  assert.equal(c.rows[0].name, 'POST /pay');                      // regressions are listed first
});
test('baseline: new and removed endpoints are detected, with a note', async () => {
  const p = await (await run(fx.load({ odd: 'GET /orders' }), { type: 'load' })).addBaseline(fx.load());
  const c = p.cmp();
  assert.equal(row(c, 'GET /orders').status, 'new');
  assert.equal(row(c, 'GET /cart').status, 'removed');
  assert.match(c.notes.join(' '), /Only 1 of 2 endpoints/);
});
test('baseline: runs with very different load carry a warning', async () => {
  const p = await (await run(fx.load({ users: 100 }), { type: 'load' })).addBaseline(fx.load({ users: 20 }));
  assert.match(p.cmp().notes.join(' '), /Peak users differ/);
  assert.equal(p.cmp().metrics.find(m => m.key === 'rps').v, 'info');
});
test('baseline: the tolerance setting changes the grading', async () => {
  const p = await (await run(fx.load({ mean: 360 }), { type: 'load' })).addBaseline(fx.load());
  assert.equal(p.rule('p95 vs baseline').status, 'warn');
  p.set('tTol', '20');
  assert.equal(p.rule('p95 vs baseline').status, 'pass');
});
test('baseline: clearing it removes the comparison and its rules', async () => {
  const p = await (await run(fx.load(), { type: 'load' })).addBaseline(fx.load());
  assert.ok(p.rule('p95 vs baseline'));
  p.clearBaseline();
  assert.equal(p.rule('p95 vs baseline'), undefined);
  assert.equal(p.card('Compared with baseline'), undefined);
});
test('baseline: a bad baseline file shows an error and keeps the current report', async () => {
  const p = await (await run(fx.load(), { type: 'load' })).addBaseline('hello,world\n1,2');
  assert.match(p.error(), /Baseline: .*JMeter CSV/);
  assert.equal(p.rendered(), true);
  assert.equal(p.hasBaseline(), false);
});
test('baseline: the HTML export includes the comparison and its chart', async () => {
  const p = await (await run(fx.load({ mean: 420 }), { type: 'load' })).addBaseline(fx.load(), 'last-release.jtl');
  const html = p.standalone();
  assert.match(html, /Compared with baseline: last-release\.jtl/);
  assert.equal((html.match(/data:image\/png/g) || []).length, 3);
});

// Deterministic JMeter CSV/JTL generators (seeded, so results are repeatable).
const HEADER = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';

function rng(seed) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r, mean, sd) => mean + sd * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// n samples, one every stepMs; fn(i, r) returns { el, ok, users }
function build(n, stepMs, fn, seed = 1) {
  const r = rng(seed), rows = [HEADER], t0 = 1700000000000;
  for (let i = 0; i < n; i++) {
    const x = fn(i, r), label = x.label || (i % 2 ? (x.odd || 'GET /cart') : 'POST /pay');
    rows.push([t0 + i * stepMs, Math.max(5, Math.round(x.el)), label, x.ok ? 200 : 503, x.ok ? 'OK' : 'Service Unavailable', 'TG 1-1', 'text', x.ok ? 'true' : 'false', x.ok ? '' : 'boom', 1000, 200, x.users, x.users, 'http://x' + label.split(' ')[1], 50, 0, 10].join(','));
  }
  return rows.join('\n');
}

// Steady 50 users for 10 minutes
const load = ({ err = 0.002, mean = 300, users = 50, odd } = {}) => build(6000, 100, (i, r) => ({ el: gauss(r, mean, 40), ok: r() > err, users, odd }));

// Same as load, but only POST /pay changes: its mean response time is payMean (GET /cart stays at 300 ms)
const loadPay = ({ payMean = 300 } = {}) => build(6000, 100, (i, r) => ({ el: gauss(r, i % 2 ? 300 : payMean, 40), ok: r() > 0.002, users: 50 }));

// 10 users, a 2-minute surge to 100 users, then back to 10. recoverSec = 0 means latency never comes back down.
const spike = ({ spikeErr = 0.08, spikeMean = 1400, recoverSec = 90 } = {}) => build(6000, 100, (i, r) => {
  const s = i / 10;
  if (s < 300) return { el: gauss(r, 250, 30), ok: r() > 0.002, users: 10 };
  if (s < 420) return { el: gauss(r, spikeMean, 200), ok: r() > spikeErr, users: 100 };
  const d = recoverSec ? Math.min(1, (s - 420) / recoverSec) : 0;
  return { el: gauss(r, spikeMean - (spikeMean - 250) * d, 30 + 100 * (1 - d)), ok: r() > 0.002, users: 10 };
});

// 50 users for ~2h13m; response time grows by `drift` over the run
const soak = ({ drift = 0.6, rows = 8000 } = {}) => build(rows, 1000, (i, r) => ({ el: gauss(r, 300 * (1 + drift * i / rows), 40), ok: r() > 0.002, users: 50 }));

// Users ramp 1 -> 300. After sample 2500 a share `lateErr` of requests fail. slope = ms added per user.
const stress = ({ lateErr = 0.45, slope = 6 } = {}) => build(6000, 100, (i, r) => {
  const u = 1 + Math.floor(i / 20);
  return { el: gauss(r, 300 + u * slope, 50), ok: r() > (i < 2500 ? 0.002 : lateErr), users: u };
});

// Uniform 100-1000 ms: the exact p95 is about 955 ms
const uniform = () => build(5000, 100, (i, r) => ({ el: 100 + 900 * r(), ok: true, users: 20 }));

module.exports = { HEADER, build, load, loadPay, spike, soak, stress, uniform };

/*!
 * jmeter-executive-summary.js  --  Test-Report-Studio (JMeter report)
 * Plain-English Executive Summary for JMeter CSV/JTL results. No dependencies, no AI, fully client-side.
 *
 * Include on jmeter.html (after css/executive-summary.css and css/jmeter-executive-summary.css):
 *   <script src="script/jmeter-executive-summary.js"></script>
 * Optional mount point (put it inside the area your PDF export captures):
 *   <div data-executive-summary-mount></div>
 *
 * It reads the same uploaded file as the main report and applies the same verdict model
 * (load / stress / spike / soak / baseline). It does NOT infer CPU, memory or DB metrics.
 */
(function () {
  'use strict';

  /* ================= config ================= */

  const BASE = { errorPct: 1, p95Ms: 2000, p99Ms: 5000, minThroughput: null, driftPct: 20, recoveryPct: 120 };
  const TYPE_DEFAULTS = {
    baseline: { ...BASE },
    load: { ...BASE },
    stress: { ...BASE, errorPct: 5, p95Ms: 3000, p99Ms: 8000 },
    spike: { ...BASE, errorPct: 5, p95Ms: 3000, p99Ms: 8000 },
    soak: { ...BASE },
  };
  const TYPE_LABEL = {
    baseline: 'baseline / performance',
    load: 'load',
    stress: 'stress',
    spike: 'spike',
    soak: 'soak',
  };
  const BUCKETS = 10;

  /* ================= helpers ================= */

  const round1 = (n) => Math.round(n * 10) / 10;
  const round2 = (n) => Math.round(n * 100) / 100;
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many || one + 's'}`;
  const fmtMs = (ms) => (ms == null || !isFinite(ms) ? 'n/a' : ms >= 1000 ? `${round2(ms / 1000)} s` : `${Math.round(ms)} ms`);
  const fmtPct = (p) => `${round2(p)}%`;
  const fmtRate = (r) => `${round1(r)} req/s`;
  const fmtDur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
  };
  const fmtClock = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const truncate = (s, n = 110) => {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const listNames = (names, max = 3) => {
    const u = [...new Set(names)];
    const shown = u.slice(0, max).map((x) => `"${x}"`).join(', ');
    return u.length > max ? `${shown} and ${u.length - max} more` : shown;
  };
  const esc = (v) =>
    String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pctile = (sorted, p) => {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };
  const sortedCopy = (arr) => Float64Array.from(arr).sort();

  /* ================= parsing ================= */

  /** Minimal RFC-4180 CSV parser (handles quoted fields containing delimiters, quotes and newlines). */
  function parseCsv(text, delim) {
    delim = delim || ',';
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function detectDelimiter(text) {
    const nl = text.indexOf('\n');
    const first = nl > 0 ? text.slice(0, nl) : text;
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let q = false;
    for (const c of first) { if (c === '"') q = !q; else if (!q && c in counts) counts[c]++; }
    const best = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
    return counts[best] ? best : ',';
  }

  const DEFAULT_COLS = ['timestamp', 'elapsed', 'label', 'responsecode', 'responsemessage', 'threadname', 'datatype', 'success', 'failuremessage', 'bytes', 'sentbytes', 'grpthreads', 'allthreads', 'latency', 'idletime', 'connect'];

  function emptyData() {
    return { n: 0, ts: [], elapsed: [], label: [], ok: [], code: [], msg: [], threads: [], hasThreads: false, diag: {} };
  }
  const toNum = (v) => (v == null || String(v).trim() === '' ? NaN : Number(v));
  const toTime = (v) => {
    const n = toNum(v);
    return isFinite(n) ? n : Date.parse(String(v).trim().replace(/\//g, '-').replace(' ', 'T')); // custom JMeter timestamp_format
  };

  function parseJtlCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    const delim = detectDelimiter(text);
    const rows = parseCsv(text, delim);
    const d = emptyData();
    d.diag = { format: 'csv', delimiter: delim === '\t' ? 'tab' : delim, rows: Math.max(0, rows.length - 1), columns: [] };
    if (!rows.length) { d.diag.problem = 'The file is empty.'; return d; }
    let cols = rows[0].map((h) => h.trim().toLowerCase());
    let start = 1;
    if (!cols.includes('elapsed') && /^\d+$/.test((rows[0][0] || '').trim())) { cols = DEFAULT_COLS; start = 0; } // header-less JTL
    d.diag.columns = cols.slice(0, 20);
    const ix = (...names) => { for (const nm of names) { const i = cols.indexOf(nm); if (i >= 0) return i; } return -1; };
    const iTs = ix('timestamp', 'ts'), iEl = ix('elapsed', 't');
    const iLb = ix('label', 'lb'), iRc = ix('responsecode', 'rc'), iRm = ix('responsemessage', 'rm');
    const iOk = ix('success', 's'), iFm = ix('failuremessage'), iAll = ix('allthreads', 'na'), iGrp = ix('grpthreads', 'ng');
    if (iTs < 0 || iEl < 0) {
      d.diag.problem = 'Could not find the "timeStamp" and "elapsed" columns. This looks like a different CSV layout (for example an aggregate/summary report rather than raw JTL results).';
      return d;
    }
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      const ts = toTime(row[iTs]), el = toNum(row[iEl]);
      if (!isFinite(ts) || !isFinite(el)) continue;
      d.ts.push(ts);
      d.elapsed.push(el);
      d.label.push(iLb >= 0 ? row[iLb] || 'Unlabelled' : 'Unlabelled');
      d.ok.push(iOk >= 0 ? String(row[iOk]).trim().toLowerCase() !== 'false' : true);
      d.code.push(iRc >= 0 ? (row[iRc] || '').trim() : '');
      d.msg.push((iFm >= 0 && row[iFm]) || (iRm >= 0 && row[iRm]) || '');
      const th = iAll >= 0 ? toNum(row[iAll]) : iGrp >= 0 ? toNum(row[iGrp]) : NaN;
      d.threads.push(isFinite(th) ? th : null);
      if (isFinite(th)) d.hasThreads = true;
    }
    d.n = d.ts.length;
    if (!d.n) d.diag.problem = 'Found the columns but no valid rows (timestamps or elapsed values could not be read).';
    return d;
  }

  /** Best-effort XML JTL support (flat <sample>/<httpSample> elements). CSV is recommended. */
  function parseJtlXml(text) {
    const d = emptyData();
    d.diag = { format: 'xml', columns: [] };
    const re = /<(?:httpSample|sample)\s([^>]*?)\/?>/g;
    let m;
    while ((m = re.exec(text))) {
      const a = {};
      m[1].replace(/([\w.-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; return ''; });
      const ts = toTime(a.ts), el = toNum(a.t);
      if (!isFinite(ts) || !isFinite(el)) continue;
      d.ts.push(ts);
      d.elapsed.push(el);
      d.label.push(a.lb || 'Unlabelled');
      d.ok.push(String(a.s).toLowerCase() !== 'false');
      d.code.push(a.rc || '');
      d.msg.push(a.rm || '');
      const th = toNum(a.na || a.ng);
      d.threads.push(isFinite(th) ? th : null);
      if (isFinite(th)) d.hasThreads = true;
    }
    d.n = d.ts.length;
    if (!d.n) d.diag.problem = 'No <sample>/<httpSample> elements with timestamps were found.';
    return d;
  }

  function parseJtl(text) {
    return /^\s*</.test(text) ? parseJtlXml(text) : parseJtlCsv(text);
  }

  /* ================= analysis ================= */

  function windowStats(d, t0, t1, inclusiveEnd) {
    const el = [];
    let errors = 0;
    for (let i = 0; i < d.n; i++) {
      const t = d.ts[i];
      if (t >= t0 && (inclusiveEnd ? t <= t1 : t < t1)) {
        el.push(d.elapsed[i]);
        if (!d.ok[i]) errors++;
      }
    }
    const s = sortedCopy(el);
    return { n: el.length, errors, errPct: el.length ? (errors / el.length) * 100 : 0, p95: pctile(s, 95), avg: el.length ? el.reduce((a, b) => a + b, 0) / el.length : null };
  }

  function analyze(d, rawCfg) {
    const type = TYPE_DEFAULTS[rawCfg && rawCfg.type] ? rawCfg.type : 'load';
    const cfg = Object.assign({}, TYPE_DEFAULTS[type], rawCfg, { type });
    if (!d || !d.n) return noData(cfg);

    const n = d.n;
    let minTs = Infinity, maxTs = -Infinity, maxEnd = -Infinity, errors = 0, sum = 0, peakThreads = 0;
    for (let i = 0; i < n; i++) {
      const t = d.ts[i];
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
      if (t + d.elapsed[i] > maxEnd) maxEnd = t + d.elapsed[i];
      if (!d.ok[i]) errors++;
      sum += d.elapsed[i];
      if (d.threads[i] != null && d.threads[i] > peakThreads) peakThreads = d.threads[i];
    }
    const spanMs = Math.max(1, maxTs - minTs);
    const durSec = Math.max(0.001, (maxEnd - minTs) / 1000);
    const errPct = (errors / n) * 100;
    const sorted = sortedCopy(d.elapsed);
    const overall = { avg: sum / n, median: pctile(sorted, 50), p95: pctile(sorted, 95), p99: pctile(sorted, 99), max: sorted[sorted.length - 1] };
    const throughput = n / durSec;

    // per-label and per-error stats
    const byLabel = new Map();
    const byErr = new Map();
    for (let i = 0; i < n; i++) {
      let L = byLabel.get(d.label[i]);
      if (!L) byLabel.set(d.label[i], (L = { label: d.label[i], n: 0, err: 0, el: [] }));
      L.n++; L.el.push(d.elapsed[i]);
      if (!d.ok[i]) {
        L.err++;
        const key = `${d.code[i] || 'No code'}|${truncate(d.msg[i], 90)}`;
        byErr.set(key, (byErr.get(key) || 0) + 1);
      }
    }
    const labels = [...byLabel.values()].map((L) => ({ ...L, p95: pctile(sortedCopy(L.el), 95), avg: L.el.reduce((a, b) => a + b, 0) / L.n }));
    const errLabels = labels.filter((l) => l.err > 0).sort((a, b) => b.err - a.err);
    const slowLabels = labels.filter((l) => l.p95 > cfg.p95Ms).sort((a, b) => b.p95 - a.p95);
    const errKinds = [...byErr.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ code: k.split('|')[0], msg: k.slice(k.indexOf('|') + 1), count: c }));

    // time buckets (for stress boundary)
    const buckets = Array.from({ length: BUCKETS }, () => ({ n: 0, err: 0, el: [], threads: 0 }));
    for (let i = 0; i < n; i++) {
      const b = buckets[Math.min(BUCKETS - 1, Math.floor(((d.ts[i] - minTs) / spanMs) * BUCKETS))];
      b.n++; b.el.push(d.elapsed[i]);
      if (!d.ok[i]) b.err++;
      if (d.threads[i] != null && d.threads[i] > b.threads) b.threads = d.threads[i];
    }
    buckets.forEach((b, i) => {
      b.i = i;
      b.errPct = b.n ? (b.err / b.n) * 100 : 0;
      b.p95 = pctile(sortedCopy(b.el), 95);
      b.rate = b.n / Math.max(0.001, spanMs / BUCKETS / 1000);
      b.atSec = (spanMs / BUCKETS / 1000) * i;
    });

    const ctx = { d, cfg, type, n, errors, errPct, overall, throughput, durSec, peakThreads, minTs, spanMs, labels, errLabels, slowLabels, errKinds, buckets };
    return compose(ctx);
  }

  /* ================= narrative ================= */

  function noData(cfg) {
    return {
      verdict: 'NO_DATA', verdictLabel: 'No results', headline: 'No samples were found in this file, so there is nothing to summarise.',
      overview: [], wentRight: [], wentWrong: [], recommendations: [], notes: [], stats: { total: 0, type: cfg.type }, config: cfg,
    };
  }

  function loadDesc(b, hasThreads) {
    return hasThreads && b.threads ? `roughly ${b.threads} active users (${fmtRate(b.rate)})` : `roughly ${fmtRate(b.rate)}`;
  }

  function compose(c) {
    const { cfg, type, n, errors, errPct, overall, throughput, durSec, peakThreads, d, buckets } = c;
    const right = [], wrong = [], recs = [], notes = [];
    const breaches = [], nears = [];

    /* ---- generic threshold checks ---- */
    const check = (name, value, limit, fmt, higherIsBetter) => {
      const breached = higherIsBetter ? value < limit : value > limit;
      const near = !breached && (higherIsBetter ? value <= limit * 1.1 : value >= limit * 0.9) && limit > 0;
      if (breached) {
        breaches.push(name);
        wrong.push(`${name} was ${fmt(value)}, ${higherIsBetter ? 'below the minimum of' : 'above the limit of'} ${fmt(limit)}.`);
      } else {
        right.push(`${name} was ${fmt(value)}, within the ${higherIsBetter ? 'minimum' : 'limit'} of ${fmt(limit)}.`);
        if (near) nears.push(name);
      }
    };

    // Stress tests are judged by where the system starts to degrade, not by whole-run averages
    // (a ramp that deliberately pushes past the limit would always "fail" those), so skip them there.
    if (errors === 0) right.push(`No errors: all ${plural(n, 'request')} succeeded.`);
    if (type !== 'stress') {
      if (errors > 0) check('Error rate', errPct, cfg.errorPct, fmtPct);
      check('95th-percentile response time (p95)', overall.p95, cfg.p95Ms, fmtMs);
      check('99th-percentile response time (p99)', overall.p99, cfg.p99Ms, fmtMs);
      if (cfg.minThroughput != null && cfg.minThroughput !== '' && isFinite(cfg.minThroughput)) check('Throughput', throughput, Number(cfg.minThroughput), fmtRate, true);
    }

    /* ---- type-specific logic ---- */
    let verdict = null;
    let headlineExtra = '';
    const stats = {};

    if (type === 'soak') {
      const first = windowStats(d, c.minTs, c.minTs + c.spanMs * 0.1, false);
      const last = windowStats(d, c.minTs + c.spanMs * 0.9, c.minTs + c.spanMs, true);
      if (first.p95 && last.p95) {
        const drift = ((last.p95 - first.p95) / first.p95) * 100;
        stats.driftPct = round1(drift); stats.firstP95 = first.p95; stats.lastP95 = last.p95;
        if (drift > cfg.driftPct) {
          breaches.push('Latency drift');
          wrong.push(`Latency drifted upward over time: p95 was ${fmtMs(first.p95)} in the first 10% of the run and ${fmtMs(last.p95)} in the last 10% (+${round1(drift)}%, limit +${cfg.driftPct}%). This is the classic sign of something accumulating over time.`);
          recs.push('Soak degradation usually points to something that builds up (for example resource leaks, growing queues or connection-pool exhaustion). Compare the timing of the drift with server-side CPU, memory and connection monitoring, which this file cannot show.');
        } else {
          right.push(`Latency stayed stable over time: p95 went from ${fmtMs(first.p95)} (first 10%) to ${fmtMs(last.p95)} (last 10%), ${drift >= 0 ? '+' : ''}${round1(drift)}% against a +${cfg.driftPct}% limit.`);
        }
        if (last.errPct > first.errPct + cfg.errorPct) {
          breaches.push('Error trend');
          wrong.push(`Errors crept up during the run: ${fmtPct(first.errPct)} at the start vs ${fmtPct(last.errPct)} at the end.`);
        }
      }
      if (durSec < 1800) notes.push(`This soak test only ran for ${fmtDur(durSec)}. Soak tests normally run for hours so that slow degradation has time to appear.`);
    }

    if (type === 'spike') {
      const base = windowStats(d, c.minTs, c.minTs + c.spanMs * 0.2, false);
      const post = windowStats(d, c.minTs + c.spanMs * 0.8, c.minTs + c.spanMs, true);
      const peak = buckets.reduce((m, b) => (b.n && (!m || (b.threads || b.rate) > (m.threads || m.rate)) ? b : m), null);
      if (base.p95 && post.p95) {
        const ratio = (post.p95 / base.p95) * 100;
        const recovered = ratio <= cfg.recoveryPct && post.errPct <= cfg.errorPct;
        stats.baselineP95 = base.p95; stats.recoveryP95 = post.p95; stats.recoveryPct = round1(ratio);
        if (peak) {
          right.splice(0, 0, `Surge window: the heaviest period (${fmtClock(peak.atSec)} into the run) ran at ${loadDesc(peak, d.hasThreads)} with p95 ${fmtMs(peak.p95)} and ${fmtPct(peak.errPct)} errors.`);
        }
        if (recovered) {
          verdict = 'recovered';
          right.push(`The system recovered: p95 returned to ${fmtMs(post.p95)} (${round1(ratio)}% of the ${fmtMs(base.p95)} pre-spike baseline; allowed up to ${cfg.recoveryPct}%) with ${fmtPct(post.errPct)} errors.`);
        } else {
          verdict = 'not_recovered';
          breaches.push('Recovery');
          wrong.push(`The system did not recover after the surge: p95 afterwards was ${fmtMs(post.p95)} (${round1(ratio)}% of the ${fmtMs(base.p95)} baseline; limit ${cfg.recoveryPct}%) with ${fmtPct(post.errPct)} errors in the final 20% of the run.`);
          recs.push('Check whether the service is stuck (exhausted pools, queues that never drain, crashed workers) and whether it needs a restart to return to normal. Extend the test tail to see if recovery just takes longer.');
        }
      } else {
        notes.push('Not enough samples at the start and end of the run to measure recovery.');
      }
      notes.push('Spike analysis assumes the surge happens in the middle of the run: the first 20% is treated as baseline and the last 20% as the recovery window.');
    }

    if (type === 'stress') {
      let idx = -1;
      buckets.forEach((b) => { if (idx < 0 && b.n && (b.errPct > cfg.errorPct || b.p95 > cfg.p95Ms)) idx = b.i; });
      const loaded = buckets.filter((b) => b.n);
      if (idx < 0) {
        verdict = 'no_break';
        headlineExtra = 'no breaking point was reached';
        right.push(`No degradation boundary was reached: error rate and p95 stayed within limits right up to ${loadDesc(loaded[loaded.length - 1], d.hasThreads)}.`);
        recs.push('The system never broke, so its true capacity is higher than what was tested. Increase the maximum load to find the real limit.');
      } else if (idx === 0) {
        verdict = 'fail_at_start';
        breaches.push('Degradation boundary');
        wrong.push(`The system was already outside its limits at the lowest load (${loadDesc(buckets[0], d.hasThreads)}): error rate ${fmtPct(buckets[0].errPct)}, p95 ${fmtMs(buckets[0].p95)}. There is no healthy operating range in this run.`);
        recs.push('Fix the basics first: this is not a capacity problem. Check the endpoint, environment and test data with a single-user run.');
      } else {
        verdict = 'boundary';
        const b = buckets[idx], prev = [...buckets.slice(0, idx)].reverse().find((x) => x.n);
        const why = b.errPct > cfg.errorPct ? `error rate rose to ${fmtPct(b.errPct)}` : `p95 rose to ${fmtMs(b.p95)}`;
        stats.boundaryAtSec = round1(b.atSec);
        right.splice(0, 0, `Healthy up to ${prev ? loadDesc(prev, d.hasThreads) : 'the start of the run'}: error rate and p95 were within limits.`);
        wrong.push(`Degradation began ${fmtClock(b.atSec)} into the run at ${loadDesc(b, d.hasThreads)}, when ${why}. This is the first degradation boundary.`);
        recs.push(`Treat ${prev ? loadDesc(prev, d.hasThreads) : 'the first stage'} as the safe ceiling for now, and investigate what saturates just above it using server-side monitoring (not available in this file).`);
        headlineExtra = `degradation began at ${loadDesc(b, d.hasThreads)}`;
      }
    }

    if (type === 'baseline') {
      notes.push('A single baseline run establishes reference behaviour. It is not proof of load, stress, spike or soak behaviour: each of those needs its own run with its own acceptance criteria.');
    }

    /* ---- shared detail: where do the problems come from? ---- */
    if (c.errors > 0 && c.errLabels.length) {
      const top = c.errLabels.slice(0, 3).map((l) => `"${l.label}" (${plural(l.err, 'error')})`).join(', ');
      const share = Math.round((c.errLabels[0].err / c.errors) * 100);
      wrong.push(`Errors by request: ${top}${c.errLabels.length > 3 ? ` and ${c.errLabels.length - 3} more` : ''}.${c.errLabels.length > 1 ? ` "${c.errLabels[0].label}" alone accounts for ${share}% of failures.` : ''}`);
    }
    if (c.errKinds.length) {
      const k = c.errKinds[0];
      wrong.push(`Most common failure: ${k.code}${k.msg ? ` "${k.msg}"` : ''} (${plural(k.count, 'time')}).`);
      const text = `${k.code} ${k.msg}`;
      if (/^5\d\d/.test(k.code)) recs.push('Server-side errors (5xx) are API or backend defects under load. Pull application logs for the period when they began.');
      else if (k.code === '429') recs.push('Rate limiting (429) is rejecting requests. Check whether the test exceeds the allowed request rate or whether the limit is too low for expected traffic.');
      else if (/timeout|timed out|refused|reset|Non HTTP|connect|socket|ENOTFOUND/i.test(text)) recs.push('Connection-level failures (timeouts, refused or reset connections) suggest the server or network ran out of capacity, or the target is unreachable. Verify the host is up and look at connection limits.');
      else if (/^4\d\d/.test(k.code)) recs.push('Client errors (4xx) usually mean the test script is wrong (expired token, bad test data, wrong path) rather than the system being slow. Verify the script with a single user.');
    }
    if (c.slowLabels.length && type !== 'stress') {
      wrong.push(`Slowest requests (p95 above ${fmtMs(cfg.p95Ms)}): ${c.slowLabels.slice(0, 3).map((l) => `"${l.label}" (${fmtMs(l.p95)})`).join(', ')}${c.slowLabels.length > 3 ? ` and ${c.slowLabels.length - 3} more` : ''}.`);
      recs.push('Profile the slowest transactions first. They dominate the overall latency percentiles.');
    }
    if (n < 100) notes.push(`Only ${n} samples were recorded, so percentiles (especially p99) are not statistically reliable.`);
    notes.push('This summary is based only on the JMeter results file. It does not cover CPU, memory, database or other server-side metrics.');

    /* ---- verdict + headline ---- */
    const label = TYPE_LABEL[type];
    let vcode, vlabel;
    if (type === 'stress') {
      if (verdict === 'no_break') { vcode = 'NO_BREAK'; vlabel = 'No breaking point reached'; }
      else if (verdict === 'fail_at_start') { vcode = 'FAILED'; vlabel = 'Failed at lowest load'; }
      else { vcode = 'BOUNDARY_FOUND'; vlabel = 'Degradation boundary found'; }
    } else if (type === 'spike') {
      if (verdict === 'not_recovered') { vcode = 'FAILED'; vlabel = 'Failed: no recovery'; }
      else if (breaches.length || nears.length) { vcode = 'PASSED_WITH_WARNINGS'; vlabel = 'Recovered, with warnings'; }
      else { vcode = 'PASSED'; vlabel = 'Passed'; }
    } else if (breaches.length) { vcode = 'FAILED'; vlabel = 'Failed'; }
    else if (nears.length) { vcode = 'PASSED_WITH_WARNINGS'; vlabel = 'Passed, close to limits'; }
    else { vcode = 'PASSED'; vlabel = 'Passed'; }

    const base = `${plural(n, 'request')} over ${fmtDur(durSec)}`;
    const headline =
      vcode === 'PASSED' ? `The ${label} test passed: ${base}, and every threshold was met.`
      : vcode === 'PASSED_WITH_WARNINGS' ? (breaches.length
          ? `The ${label} test recovered, but ${breaches.join(', ').toLowerCase()} exceeded the limits during the run.`
          : `The ${label} test passed, but ${nears.join(' and ').toLowerCase()} came close to the limit.`)
      : vcode === 'FAILED' ? `The ${label} test failed: ${breaches.join(', ').toLowerCase()} did not meet the acceptance criteria.`
      : vcode === 'NO_BREAK' ? `The stress test did not find a breaking point: the system stayed within limits for the whole ${fmtDur(durSec)} ramp.`
      : `The stress test found where the system starts to degrade: ${headlineExtra}.`;

    /* ---- overview ---- */
    const overview = [];
    let scope = `This ${label} test sent ${base}, averaging ${fmtRate(throughput)}`;
    if (d.hasThreads && peakThreads) scope += ` with up to ${plural(peakThreads, 'concurrent user')}`;
    overview.push(scope + '.');
    overview.push(`Response times: average ${fmtMs(overview_avg(c))}, median ${fmtMs(overall.median)}, p95 ${fmtMs(overall.p95)}, p99 ${fmtMs(overall.p99)}, slowest ${fmtMs(overall.max)}. ${errors === 0 ? 'No requests failed.' : `${plural(errors, 'request')} failed (${fmtPct(errPct)}).`}`);
    if (!d.hasThreads && (type === 'stress' || type === 'spike')) notes.push('The file has no active-thread column (allThreads), so load levels are described by request rate instead of concurrent users.');

    Object.assign(stats, {
      type, total: n, errors, errorPct: round2(errPct), durationSec: round1(durSec), throughput: round1(throughput),
      avgMs: Math.round(overall.avg), p95Ms: overall.p95, p99Ms: overall.p99, maxMs: overall.max, peakThreads: peakThreads || null,
    });

    return { verdict: vcode, verdictLabel: vlabel, headline, overview, wentRight: right, wentWrong: wrong, recommendations: dedupe(recs).concat(vcode === 'PASSED' ? ['No action needed. Re-run with a heavier workload or longer duration to widen confidence.'] : []), notes, stats, config: cfg };
  }

  function overview_avg(c) { return c.overall.avg; }
  function dedupe(a) { return [...new Set(a)]; }

  /* ================= rendering ================= */

  const VERDICT_CLASS = { PASSED: 'es-pass', PASSED_WITH_WARNINGS: 'es-warn', FAILED: 'es-fail', BOUNDARY_FOUND: 'es-info', NO_BREAK: 'es-info', NO_DATA: 'es-none' };
  const ul = (items) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');

  function renderBody(s) {
    const right = s.wentRight.length ? `<div class="es-col es-right"><h3>✅ What went right</h3>${ul(s.wentRight)}</div>` : '';
    const wrong = s.wentWrong.length ? `<div class="es-col es-wrong"><h3>⚠️ What went wrong</h3>${ul(s.wentWrong)}</div>` : '';
    return `
  <div class="es-head"><h2>Executive Summary</h2><span class="es-badge">${esc(s.verdictLabel)}</span></div>
  <p class="es-headline">${esc(s.headline)}</p>
  ${s.overview.map((p) => `<p>${esc(p)}</p>`).join('')}
  ${right || wrong ? `<div class="es-cols${right && wrong ? '' : ' es-cols-one'}">${right}${wrong}</div>` : ''}
  ${s.recommendations.length ? `<div class="es-recs"><h3>🛠️ Recommended next steps</h3>${ul(s.recommendations)}</div>` : ''}
  ${s.notes.map((n) => `<p class="es-note">${esc(n)}</p>`).join('')}
  <p class="es-note">Generated automatically from this run's results (rule-based, no AI).</p>`;
  }

  const FIELDS = [
    ['errorPct', 'Max error rate (%)', 0.1],
    ['p95Ms', 'Max p95 (ms)', 50],
    ['p99Ms', 'Max p99 (ms)', 50],
    ['minThroughput', 'Min throughput (req/s, optional)', 1],
    ['driftPct', 'Soak: max p95 drift (%)', 1],
    ['recoveryPct', 'Spike: recovery limit (% of baseline p95)', 5],
  ];

  function controlsHtml(cfg) {
    const opts = Object.keys(TYPE_LABEL).map((t) => `<option value="${t}"${t === cfg.type ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`).join('');
    const inputs = FIELDS.map(([k, lab, step]) => `<label>${esc(lab)}<input type="number" min="0" step="${step}" data-es-field="${k}" value="${cfg[k] == null ? '' : esc(cfg[k])}"></label>`).join('');
    return `<details class="es-controls"><summary>Summary settings (test type &amp; thresholds)</summary>
      <p class="es-note">The verdict below uses these settings. Set them to match the acceptance criteria you chose for the main report.</p>
      <div class="es-grid"><label>Test type<select data-es-field="type">${opts}</select></label>${inputs}</div></details>`;
  }

  /* ================= browser hook ================= */

  function typeFromText(t) {
    t = String(t || '');
    if (/stress/i.test(t)) return 'stress';
    if (/spike/i.test(t)) return 'spike';
    if (/soak|endurance/i.test(t)) return 'soak';
    if (/load/i.test(t)) return 'load';
    if (/base|perform/i.test(t)) return 'baseline';
    return null;
  }

  function initBrowser() {
    const DEBUG = /[?&]esdebug=1/.test(location.search) || window.JMES_DEBUG;
    const log = (...a) => { if (DEBUG) console.log('[JMES]', ...a); };
    const state = { data: null, cfg: Object.assign({ type: 'load' }, TYPE_DEFAULTS.load), node: null, observer: null, hooked: new WeakSet(), lastKey: null, pendingKey: null, lastDiag: null };
    console.info('[JMeter Executive Summary] loaded. Add ?esdebug=1 to the page URL for details.');

    const NAME_OK = /\.(jtl|csv|xml|txt)(\?|#|$)/i;
    const origReadAsText = FileReader.prototype.readAsText;

    const findTypeSelect = () => {
      for (const sel of document.querySelectorAll('select')) {
        if (sel.closest('.es')) continue;
        const hits = new Set([...sel.options].map((o) => typeFromText(o.value + ' ' + o.text)).filter(Boolean));
        if (hits.size >= 3) return sel;
      }
      return null;
    };

    const update = () => {
      if (!state.node || state.notice) return;
      const s = analyze(state.data, state.cfg);
      state.node.className = `es es-jm ${VERDICT_CLASS[s.verdict] || 'es-none'}`;
      state.node.querySelector('.es-body').innerHTML = renderBody(s);
      window.JMeterExecutiveSummary.last = s;
    };

    const place = () => {
      const node = state.node;
      if (!node) return;
      const mount = document.querySelector('[data-executive-summary-mount]');
      const footer = document.querySelector('footer');
      if (mount) mount.appendChild(node);
      else if (footer && footer.parentNode) footer.parentNode.insertBefore(node, footer);
      else (document.querySelector('main') || document.body).appendChild(node);
      log('placed', mount ? 'in mount point' : footer ? 'above footer' : 'at end of page');
      // If it landed inside something that stays hidden, move it to the end of the page so it is always seen.
      [1200, 3500].forEach((ms) => setTimeout(() => {
        if (state.node === node && node.isConnected && node.getClientRects().length === 0) {
          log('hidden where placed; moving to end of page');
          document.body.appendChild(node);
        }
      }, ms));
    };

    const syncControls = () => {
      if (!state.node || state.notice) return;
      state.node.querySelectorAll('[data-es-field]').forEach((el) => {
        const k = el.getAttribute('data-es-field');
        el.value = state.cfg[k] == null ? '' : state.cfg[k];
      });
    };

    const setType = (type) => {
      if (!TYPE_DEFAULTS[type]) return;
      state.cfg = Object.assign({}, TYPE_DEFAULTS[type], { type });
      syncControls();
      update();
    };

    const watchDom = () => {
      if (state.observer) state.observer.disconnect();
      let timer = null;
      state.observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (state.node && !document.getElementById('executive-summary')) place(); }, 150);
      });
      state.observer.observe(document.body, { childList: true, subtree: true });
    };

    const showNotice = (message, diag) => {
      const old = document.getElementById('executive-summary');
      if (old) old.remove();
      const node = document.createElement('section');
      node.id = 'executive-summary';
      node.className = 'es es-jm es-none';
      const cols = diag && diag.columns && diag.columns.length ? `<p class="es-note">Columns found: ${esc(diag.columns.join(', '))}</p>` : '';
      node.innerHTML = `<div class="es-body"><div class="es-head"><h2>Executive Summary</h2><span class="es-badge">Unavailable</span></div><p class="es-headline">${esc(message)}</p>${cols}<p class="es-note">The main report is not affected. Use a raw JMeter results file (.jtl or .csv with timeStamp and elapsed columns).</p></div>`;
      state.node = node; state.notice = true;
      place(); watchDom();
    };

    const show = (data) => {
      state.data = data; state.notice = false;
      const old = document.getElementById('executive-summary');
      if (old) old.remove();
      const sel = findTypeSelect();
      const detected = sel && typeFromText(sel.value + ' ' + (sel.options[sel.selectedIndex] || {}).text);
      state.cfg = Object.assign({}, TYPE_DEFAULTS[detected || state.cfg.type], { type: detected || state.cfg.type });

      const node = document.createElement('section');
      node.id = 'executive-summary';
      node.innerHTML = controlsHtml(state.cfg) + '<div class="es-body"></div>';
      node.addEventListener('input', (e) => {
        const k = e.target && e.target.getAttribute && e.target.getAttribute('data-es-field');
        if (!k || k === 'type') return;
        const v = e.target.value;
        state.cfg[k] = v === '' ? (k === 'minThroughput' ? null : TYPE_DEFAULTS[state.cfg.type][k]) : Number(v);
        update();
      });
      node.addEventListener('change', (e) => {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-es-field') === 'type') setType(e.target.value);
      });
      state.node = node;
      place();
      update();

      // follow the page's own test-type selector, if it has one
      if (sel && !state.hooked.has(sel)) {
        state.hooked.add(sel);
        sel.addEventListener('change', () => {
          const t = typeFromText(sel.value + ' ' + (sel.options[sel.selectedIndex] || {}).text);
          if (t && state.data) setType(t);
        });
      }
      watchDom();
    };

    /** Single entry point: every route (file input, drop, fetch, XHR, FileReader, Blob.text) ends up here. */
    const handleText = (text, key, name) => {
      if (key && key === state.lastKey && document.getElementById('executive-summary')) return;
      state.lastKey = key;
      let data;
      try { data = parseJtl(String(text)); } catch (e) { console.warn('[JMeter Executive Summary] parse error:', e); showNotice('The results file could not be parsed.'); return; }
      state.lastDiag = data.diag;
      log('parsed', name, data.n, 'samples', data.diag);
      if (data.n) show(data);
      else showNotice(`The executive summary could not read "${name}". ${data.diag.problem || ''}`, data.diag);
    };

    const readBlob = (file) => {
      if (!file || !file.name || !NAME_OK.test(file.name)) return;
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (key === state.pendingKey || (key === state.lastKey && document.getElementById('executive-summary'))) return;
      state.pendingKey = key;
      log('file seen', file.name, file.size);
      const fr = new FileReader();
      fr.onload = () => { state.pendingKey = null; handleText(fr.result, key, file.name); };
      fr.onerror = () => { state.pendingKey = null; };
      origReadAsText.call(fr, file); // unpatched method: no recursion
    };

    // 1) explicit upload routes
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files && t.files[0]) readBlob(t.files[0]);
    }, true);
    document.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readBlob(f);
    }, true);

    // 2) however the page itself reads a file
    FileReader.prototype.readAsText = function (blob) {
      try { readBlob(blob); } catch (_) { /* never break the host page */ }
      return origReadAsText.apply(this, arguments);
    };
    if (window.Blob && Blob.prototype.text) {
      const origText = Blob.prototype.text;
      Blob.prototype.text = function () {
        try { readBlob(this); } catch (_) {}
        return origText.apply(this, arguments);
      };
    }

    // 3) sample files / remote results loaded by the page (fetch + XHR)
    if (window.fetch) {
      const origFetch = window.fetch;
      window.fetch = function (input) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : input && input.url;
          if (url && NAME_OK.test(url.split('?')[0]) && !/\.xml$/i.test(url.split('?')[0])) {
            p.then((r) => (r && r.ok ? r.clone().text() : null)).then((t) => { if (t) handleText(t, `fetch|${url}|${t.length}`, url.split('/').pop().split('?')[0]); }).catch(() => {});
          }
        } catch (_) {}
        return p;
      };
    }
    if (window.XMLHttpRequest) {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (url && NAME_OK.test(String(url).split('?')[0])) {
            this.addEventListener('load', () => {
              try {
                const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
                if (t) handleText(t, `xhr|${url}|${t.length}`, String(url).split('/').pop().split('?')[0]);
              } catch (_) {}
            });
          }
        } catch (_) {}
        return origOpen.apply(this, arguments);
      };
    }

    window.JMeterExecutiveSummary = {
      parse: parseJtl, analyze, show, setType, last: null,
      fromText: (text, name) => handleText(text, null, name || 'pasted data'),
      diagnose: () => ({ loaded: true, sectionInPage: !!document.getElementById('executive-summary'), visible: !!(state.node && state.node.getClientRects().length), lastFile: state.lastKey, lastParse: state.lastDiag }),
    };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBrowser);
    else initBrowser();
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseJtl, parseCsv, analyze, renderBody, TYPE_DEFAULTS };
  }
})();

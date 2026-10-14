/*!
 * executive-summary.js  --  Test-Report-Studio (Postman report)
 * Adds a plain-English Executive Summary under the dashboard. No dependencies, no AI, runs fully in the browser.
 * Include on postman.html:  <script src="script/executive-summary.js"></script>
 * Optional mount point:      <div data-executive-summary-mount></div>   (put it inside the area your PDF export captures)
 */
(function () {
  'use strict';

/**
 * executiveSummary.js
 * Rule-based, dependency-free executive summary for TestVista Postman/Newman reports.
 *
 * Input : the normalized + sanitized report object (same data that feeds the dashboard/JSON export)
 * Output: a plain object { verdict, headline, overview[], wentRight[], wentWrong[], recommendations[], stats }
 *
 * Field names are read defensively (see `pick`) so small differences in newmanParser's
 * output shape won't break it.
 */

const DEFAULTS = {
  slowMs: 1000,        // a request slower than this is "slow"
  verySlowMs: 3000,    // ...and this is "very slow"
  partialPassRate: 80, // pass rate (%) at or above this = PARTIAL instead of FAILED
};

/* ---------- small helpers ---------- */

const pick = (obj, keys) => {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};
const toNum = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b ? round1((a / b) * 100) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const truncate = (s, n = 140) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const listNames = (names, max = 3) => {
  const uniq = [...new Set(names)];
  const shown = uniq.slice(0, max).map((n) => `"${n}"`).join(', ');
  return uniq.length > max ? `${shown} and ${uniq.length - max} more` : shown;
};
const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};
const fmtMs = (ms) => (ms == null ? 'n/a' : ms >= 1000 ? `${round1(ms / 1000)} s` : `${Math.round(ms)} ms`);

/** Collapse ids so /users/42 and /users/77 count as one endpoint. */
function endpointKey(method, url) {
  let path = String(url || '');
  try {
    path = new URL(path).pathname;
  } catch (_) {
    path = path.replace(/^[a-z]+:\/\//i, '').replace(/^[^/]*/, '') || path; // handles {{baseUrl}}/x
    path = path.split('?')[0];
  }
  path = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
  return `${String(method || 'GET').toUpperCase()} ${path || '/'}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return null;
  }
}

/* ---------- normalisation ---------- */

function normalizeRequest(r, index) {
  let status = pick(r, ['status', 'statusCode', 'code', 'responseCode']);
  if (status && typeof status === 'object') status = pick(status, ['code', 'status']);
  const statusNum = toNum(status);

  const rawAssertions = pick(r, ['assertions', 'tests']) || [];
  const assertions = (Array.isArray(rawAssertions) ? rawAssertions : []).map((a) => {
    if (typeof a === 'string') return { name: a, passed: true, error: '' };
    const error = pick(a, ['error', 'errorMessage', 'message']) || '';
    const st = String(pick(a, ['status', 'result']) || '').toLowerCase();
    const explicit = pick(a, ['passed', 'pass', 'ok', 'success']);
    const passed = explicit !== undefined ? !!explicit : st ? st === 'passed' || st === 'pass' : !error;
    return { name: pick(a, ['name', 'assertion', 'test', 'title']) || 'Unnamed assertion', passed, error };
  });

  const rawFailures = pick(r, ['failures', 'errors']) || [];
  const failureMessages = (Array.isArray(rawFailures) ? rawFailures : [])
    .map((f) => (typeof f === 'string' ? f : pick(f, ['message', 'error', 'name']) || ''))
    .filter(Boolean);

  const failedAssertions = assertions.filter((a) => !a.passed);
  const explicitStatus = String(pick(r, ['result', 'outcome']) || '').toLowerCase();
  const explicitFailed =
    pick(r, ['failed', 'isFailed']) === true ||
    pick(r, ['passed', 'isPassed']) === false ||
    explicitStatus === 'failed' ||
    (typeof pick(r, ['status']) === 'string' && /^fail/i.test(pick(r, ['status'])));
  // same fallback rule TestVista documents: HTTP error status + zero assertions = failure
  const silentHttpError = statusNum !== null && statusNum >= 400 && assertions.length === 0;

  const failed = explicitFailed || failedAssertions.length > 0 || failureMessages.length > 0 || silentHttpError;

  return {
    index,
    name: pick(r, ['name', 'requestName', 'title']) || `Request ${index + 1}`,
    method: String(pick(r, ['method']) || 'GET').toUpperCase(),
    url: pick(r, ['url', 'endpoint']) || '',
    status: statusNum,
    responseTime: toNum(pick(r, ['responseTime', 'time', 'duration', 'elapsed'])),
    iteration: toNum(pick(r, ['iteration', 'iterationIndex'])),
    assertions,
    failedAssertions,
    messages: [...failureMessages, ...failedAssertions.map((a) => a.error).filter(Boolean)],
    failed,
    silentHttpError,
  };
}

/* ---------- failure classification ---------- */

const CAUSES = {
  network: {
    label: 'Connection problems',
    explain: (n) => `${plural(n, 'request')} never received a response (DNS, refused connection, timeout or network error).`,
    advice: 'Check that the base URL and environment are correct, the service is up, and the network/VPN allows the call.',
  },
  server: {
    label: 'Server errors (5xx)',
    explain: (n) => `${plural(n, 'request')} reached the API but it crashed or failed internally.`,
    advice: 'These are defects in the API or its dependencies. Pull the server logs for the timestamps of these calls.',
  },
  auth: {
    label: 'Authentication / permission errors (401/403)',
    explain: (n) => `${plural(n, 'request')} ${n === 1 ? 'was' : 'were'} rejected because the credentials were missing, expired or not allowed.`,
    advice: 'Refresh the token or API key in the environment and confirm the test user has permission for these endpoints.',
  },
  notFound: {
    label: 'Not found (404)',
    explain: (n) => `${plural(n, 'request')} pointed to a resource or route that does not exist.`,
    advice: 'Verify the URL path and that any ID the request depends on was created by an earlier step.',
  },
  client: {
    label: 'Client errors (other 4xx)',
    explain: (n) => `${plural(n, 'request')} ${n === 1 ? 'was' : 'were'} rejected as invalid (for example bad input or a validation rule).`,
    advice: 'Compare the request body/params with the API contract and check the response message for the rejected field.',
  },
  assertion: {
    label: 'Response did not match expectations',
    explain: (n) => `${plural(n, 'request')} succeeded technically, but the response failed one or more test assertions.`,
    advice: 'The API answered, but with different data or structure than the test expects. Decide whether the API or the test is wrong.',
  },
};

function classify(r) {
  const text = r.messages.join(' ');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|timed? ?out|getaddrinfo/i.test(text)) return 'network';
  if (r.status === null) return 'network';
  if (r.status >= 500) return 'server';
  if (r.status === 401 || r.status === 403) return 'auth';
  if (r.status === 404) return 'notFound';
  if (r.status >= 400) return 'client';
  return 'assertion';
}

/* ---------- main ---------- */

function buildExecutiveSummary(report, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const rawRequests = pick(report, ['requests', 'results', 'tests', 'items']) || [];
  const requests = (Array.isArray(rawRequests) ? rawRequests : []).map(normalizeRequest);

  const total = requests.length;
  const failedReqs = requests.filter((r) => r.failed);
  const failed = failedReqs.length;
  const passed = total - failed;
  const passRate = pct(passed, total);

  const times = requests.map((r) => r.responseTime).filter((t) => t !== null).sort((a, b) => a - b);
  const avgMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const p95Ms = percentile(times, 95);
  const slowest = [...requests].filter((r) => r.responseTime !== null).sort((a, b) => b.responseTime - a.responseTime).slice(0, 3);
  const slow = requests.filter((r) => r.responseTime !== null && r.responseTime >= cfg.slowMs);
  const verySlow = requests.filter((r) => r.responseTime !== null && r.responseTime >= cfg.verySlowMs);

  const allAssertions = requests.flatMap((r) => r.assertions);
  const assertionsFailed = allAssertions.filter((a) => !a.passed).length;
  const noAssertionReqs = requests.filter((r) => r.assertions.length === 0);

  const iterationNums = new Set(requests.map((r) => r.iteration).filter((n) => n !== null));
  const iterations = Math.max(toNum(pick(report, ['iterations', 'iterationCount'])) || 0, iterationNums.size, 1);
  const envName = pick(report, ['environment', 'environmentName']);
  const environment = typeof envName === 'object' ? pick(envName, ['name']) : envName;
  const hosts = [...new Set(requests.map((r) => hostOf(r.url)).filter(Boolean))];

  // group failures by cause
  const byCause = {};
  failedReqs.forEach((r) => {
    const key = classify(r);
    (byCause[key] = byCause[key] || []).push(r);
  });

  // flaky = same endpoint passes in some iterations and fails in others
  const byEndpoint = {};
  requests.forEach((r) => {
    const k = `${r.name}|${endpointKey(r.method, r.url)}`;
    (byEndpoint[k] = byEndpoint[k] || []).push(r);
  });
  const flaky = Object.values(byEndpoint).filter((g) => g.length > 1 && g.some((r) => r.failed) && g.some((r) => !r.failed));
  const flakyNames = flaky.map((g) => g[0].name);

  // ----- verdict -----
  let verdict;
  if (total === 0) verdict = 'NO_DATA';
  else if (failed === 0) verdict = slow.length || noAssertionReqs.length || flaky.length ? 'PASSED_WITH_WARNINGS' : 'PASSED';
  else if (passRate >= cfg.partialPassRate) verdict = 'PARTIAL';
  else verdict = 'FAILED';

  const verdictLabel = {
    PASSED: 'Passed',
    PASSED_WITH_WARNINGS: 'Passed with warnings',
    PARTIAL: 'Partially passed',
    FAILED: 'Failed',
    NO_DATA: 'No results',
  }[verdict];

  // ----- headline -----
  const headline =
    verdict === 'NO_DATA'
      ? 'No requests were found in this run, so there is nothing to summarise.'
      : verdict === 'PASSED'
      ? `All ${plural(total, 'request')} passed. The API behaved as the tests expect.`
      : verdict === 'PASSED_WITH_WARNINGS'
      ? `All ${plural(total, 'request')} passed, but there are a few things worth a look.`
      : verdict === 'PARTIAL'
      ? `${passed} of ${total} requests passed (${passRate}%). Most things work, but ${plural(failed, 'request')} failed and need attention.`
      : `Only ${passed} of ${total} requests passed (${passRate}%). This run is not healthy and should not be considered a success.`;

  // ----- overview paragraphs -----
  const overview = [];
  if (total > 0) {
    let scope = `This run executed ${plural(total, 'request')}`;
    if (iterations > 1) scope += ` across ${iterations} iterations`;
    if (environment) scope += ` using the "${environment}" environment`;
    if (hosts.length === 1) scope += ` against ${hosts[0]}`;
    else if (hosts.length > 1) scope += ` against ${hosts.length} hosts`;
    scope += `, checking ${plural(allAssertions.length, 'assertion')} in total.`;
    overview.push(scope);

    if (failed === 0) {
      overview.push(`Every request returned a response and every assertion held, which means the endpoints tested are working as designed for the scenarios covered.`);
    } else {
      const causeSummary = Object.keys(byCause)
        .sort((a, b) => byCause[b].length - byCause[a].length)
        .map((k) => `${byCause[k].length} × ${CAUSES[k].label.toLowerCase()}`)
        .join(', ');
      overview.push(`${plural(failed, 'request')} failed (${causeSummary}). ${assertionsFailed} of ${allAssertions.length} assertions did not hold.`);
    }

    if (avgMs !== null) {
      let perf = `Average response time was ${fmtMs(avgMs)}, with 95% of requests finishing within ${fmtMs(p95Ms)}.`;
      if (slowest.length && slowest[0].responseTime >= cfg.slowMs) {
        perf += ` The slowest was "${slowest[0].name}" at ${fmtMs(slowest[0].responseTime)}.`;
      }
      overview.push(perf);
    }
  }

  // ----- what went right -----
  const wentRight = [];
  if (total > 0) {
    if (passed > 0) wentRight.push(`${plural(passed, 'request')} passed every check (${passRate}% pass rate).`);
    const answered = requests.filter((r) => r.status !== null).length;
    if (answered === total) wentRight.push('Every request received a response, so the API was reachable throughout the run.');
    if (!byCause.server) wentRight.push('No server errors (5xx) were returned.');
    if (!byCause.auth && !requests.some((r) => r.status === 401 || r.status === 403)) wentRight.push('No authentication or permission errors (401/403).');
    if (allAssertions.length && assertionsFailed === 0) wentRight.push(`All ${plural(allAssertions.length, 'assertion')} passed.`);
    else if (allAssertions.length) wentRight.push(`${allAssertions.length - assertionsFailed} of ${allAssertions.length} assertions passed.`);
    if (avgMs !== null && slow.length === 0) wentRight.push(`Performance was healthy: nothing exceeded ${fmtMs(cfg.slowMs)}, and the average was ${fmtMs(avgMs)}.`);
    if (iterations > 1 && flaky.length === 0 && failed === 0) wentRight.push(`Results were consistent across all ${iterations} iterations.`);
  }

  // ----- what went wrong -----
  const wentWrong = [];
  Object.keys(byCause)
    .sort((a, b) => byCause[b].length - byCause[a].length)
    .forEach((k) => {
      const reqs = byCause[k];
      const sample = reqs.map((r) => r.messages[0]).find(Boolean);
      let line = `${CAUSES[k].label}: ${CAUSES[k].explain(reqs.length)} Affected: ${listNames(reqs.map((r) => r.name))}.`;
      if (sample) line += ` First reported reason: "${truncate(sample)}"`;
      wentWrong.push(line);
    });
  if (flaky.length) {
    wentWrong.push(`Inconsistent results: ${listNames(flakyNames)} passed in some iterations and failed in others, which points to flaky behaviour, data dependency or rate limiting.`);
  }
  if (verySlow.length) {
    wentWrong.push(`Very slow responses (over ${fmtMs(cfg.verySlowMs)}): ${listNames(verySlow.map((r) => r.name))}.`);
  } else if (slow.length) {
    wentWrong.push(`Slow responses (over ${fmtMs(cfg.slowMs)}): ${listNames(slow.map((r) => r.name))}.`);
  }
  if (noAssertionReqs.length) {
    const silent = noAssertionReqs.filter((r) => r.silentHttpError).length;
    wentWrong.push(
      `Coverage gap: ${plural(noAssertionReqs.length, 'request has', 'requests have')} no assertions (${listNames(noAssertionReqs.map((r) => r.name))}), so a pass on them only means "a response came back".` +
        (silent ? ` ${plural(silent, 'of these')} returned an HTTP error and was flagged as failed automatically.` : '')
    );
  }

  // ----- recommendations -----
  const recommendations = [];
  Object.keys(byCause)
    .sort((a, b) => byCause[b].length - byCause[a].length)
    .forEach((k) => recommendations.push(CAUSES[k].advice));
  if (flaky.length) recommendations.push('Re-run the flaky requests in isolation and check for shared state, test-data collisions or rate limits.');
  if (slow.length) recommendations.push('Profile the slow endpoints, or raise the slow-response threshold if this latency is acceptable for them.');
  if (noAssertionReqs.length) recommendations.push('Add at least a status-code and one body assertion to each request that currently has none.');
  if (verdict === 'PASSED') recommendations.push('No action needed. Consider adding negative-path tests (bad input, expired token) to widen coverage.');

  const stats = {
    total, passed, failed, passRate, iterations,
    assertionsTotal: allAssertions.length, assertionsFailed,
    avgResponseMs: avgMs === null ? null : Math.round(avgMs),
    p95ResponseMs: p95Ms,
    slowRequests: slow.length, requestsWithoutAssertions: noAssertionReqs.length,
    flakyRequests: flaky.length,
    failuresByCause: Object.fromEntries(Object.entries(byCause).map(([k, v]) => [k, v.length])),
  };

  return { verdict, verdictLabel, headline, overview, wentRight, wentWrong, recommendations, stats, ai: null, generatedBy: 'rules' };
}



/**
 * components/executiveSummary.js
 * Renders the executive summary as an HTML section. Every dynamic value is HTML-escaped,
 * consistent with TestVista's rule that nothing dynamic reaches the page unescaped.
 */

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const VERDICT_CLASS = {
  PASSED: 'es-pass',
  PASSED_WITH_WARNINGS: 'es-warn',
  PARTIAL: 'es-warn',
  FAILED: 'es-fail',
  NO_DATA: 'es-none',
};

const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');

function renderExecutiveSummary(summary) {
  if (!summary) return '';
  const cls = VERDICT_CLASS[summary.verdict] || 'es-none';

  const right = summary.wentRight.length
    ? `<div class="es-col es-right"><h3>✅ What went right</h3>${list(summary.wentRight)}</div>`
    : '';
  const wrong = summary.wentWrong.length
    ? `<div class="es-col es-wrong"><h3>⚠️ What went wrong</h3>${list(summary.wentWrong)}</div>`
    : '';
  const recs = summary.recommendations.length
    ? `<div class="es-recs"><h3>🛠️ Recommended next steps</h3>${list(summary.recommendations)}</div>`
    : '';
  const ai = summary.ai
    ? `<div class="es-ai"><h3>🤖 AI-written narrative</h3>${summary.ai
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p)}</p>`)
        .join('')}<p class="es-note">Generated by an AI model from the sanitized figures above. Verify against the detailed results.</p></div>`
    : '';

  return `
<section class="es ${cls}" id="executive-summary" aria-labelledby="es-title">
  <div class="es-head">
    <h2 id="es-title">Executive Summary</h2>
    <span class="es-badge">${esc(summary.verdictLabel)}</span>
  </div>
  <p class="es-headline">${esc(summary.headline)}</p>
  ${summary.overview.map((p) => `<p>${esc(p)}</p>`).join('')}
  ${right || wrong ? `<div class="es-cols">${right}${wrong}</div>` : ''}
  ${recs}
  ${ai}
  <p class="es-note">Summary generated automatically from this run's results${summary.ai ? ' (rules + AI)' : ' (rule-based, no AI)'}.</p>
</section>`;
}


/* ---------- adapter: Postman export -> normalized run ---------- */

function adaptPostmanExport(json) {
  if (!json || typeof json !== 'object') return { requests: [] };

  // A) Postman Collection Runner export  ({ results: [...] })
  if (Array.isArray(json.results)) {
    const methodById = {};
    const reqs = (json.collection && json.collection.requests) || [];
    reqs.forEach((q) => { if (q && q.id) methodById[q.id] = q.method; });

    const out = [];
    json.results.forEach((r) => {
      const status = r.responseCode && typeof r.responseCode === 'object' ? r.responseCode.code : r.responseCode;
      const method = r.method || methodById[r.id] || 'GET';
      const perIteration = Array.isArray(r.allTests) && r.allTests.length > 1 ? r.allTests : null;
      const toAssertions = (obj) =>
        Object.entries(obj || {}).map(([name, passed]) => ({ name, passed: !!passed, error: passed ? '' : 'Assertion failed' }));

      if (perIteration) {
        perIteration.forEach((tests, i) => {
          out.push({
            name: r.name, method, url: r.url, status,
            responseTime: Array.isArray(r.times) ? r.times[i] : r.time,
            iteration: i, assertions: toAssertions(tests),
          });
        });
      } else {
        out.push({
          name: r.name, method, url: r.url, status,
          responseTime: r.time != null ? r.time : Array.isArray(r.times) ? r.times[0] : null,
          assertions: toAssertions(r.tests),
        });
      }
    });
    return { requests: out, environment: json.environment_name || (json.environment && json.environment.name) || null, iterations: json.count };
  }

  // B) Newman JSON export  ({ run: { executions: [...] } })
  if (json.run && Array.isArray(json.run.executions)) {
    const urlOf = (u) => {
      if (!u) return '';
      if (typeof u === 'string') return u;
      if (u.raw) return u.raw;
      const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
      const p = Array.isArray(u.path) ? u.path.join('/') : u.path || '';
      return `${u.protocol ? u.protocol + '://' : ''}${host}/${p}`;
    };
    const requests = json.run.executions.map((e) => ({
      name: (e.item && e.item.name) || 'Request',
      method: e.request && e.request.method,
      url: urlOf(e.request && e.request.url),
      status: e.response ? e.response.code : null,
      responseTime: e.response ? e.response.responseTime : null,
      iteration: e.cursor ? e.cursor.iteration : null,
      assertions: (e.assertions || []).map((a) => ({
        name: a.assertion, passed: !a.error, error: a.error ? a.error.message : '',
      })),
      failures: e.requestError ? [e.requestError.message || String(e.requestError)] : [],
    }));
    return {
      requests,
      environment: json.environment && json.environment.name,
      iterations: json.run.stats && json.run.stats.iterations && json.run.stats.iterations.total,
    };
  }

  // C) Already normalized ({ requests: [...] })
  return json;
}

function summarizeExport(json, options) {
  return buildExecutiveSummary(adaptPostmanExport(json), options);
}

/* ---------- browser hook: auto-render under the dashboard ---------- */

function initBrowser() {
  let lastHtml = '';
  let observer = null;

  const place = (html) => {
    const old = document.getElementById('executive-summary');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const node = wrap.firstElementChild;
    if (!node) return;

    const mount = document.querySelector('[data-executive-summary-mount]');
    if (mount) { mount.appendChild(node); return; }
    const footer = document.querySelector('footer');
    if (footer && footer.parentNode) { footer.parentNode.insertBefore(node, footer); return; }
    (document.querySelector('main') || document.body).appendChild(node);
  };

  const render = (json) => {
    let summary;
    try { summary = summarizeExport(json); } catch (e) { console.warn('[Executive Summary] could not summarise this file:', e); return; }
    lastHtml = renderExecutiveSummary(summary);
    place(lastHtml);

    // If the dashboard re-renders and wipes the section, put it back.
    if (observer) observer.disconnect();
    let t = null;
    observer = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (lastHtml && !document.getElementById('executive-summary')) place(lastHtml); }, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  const readFile = (file) => {
    if (!file || !/\.json$/i.test(file.name || '') && file.type !== 'application/json') return;
    const fr = new FileReader();
    fr.onload = () => { try { render(JSON.parse(fr.result)); } catch (_) { /* not valid JSON: the main app shows its own error */ } };
    fr.readAsText(file);
  };

  // Piggy-back on whatever upload method the page already uses. Does not interfere with app.js.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files && t.files[0]) readFile(t.files[0]);
  }, true);
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  }, true);

  window.ExecutiveSummary = { build: buildExecutiveSummary, render: renderExecutiveSummary, fromExport: summarizeExport, show: render };
}

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBrowser);
    else initBrowser();
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildExecutiveSummary, renderExecutiveSummary, adaptPostmanExport, summarizeExport };
  }
})();

let allTests = [];
let passedTests = [];
let failedTests = [];
const fileInput = document.getElementById('fileInput');
const jsonUploadArea = document.getElementById('jsonUploadArea');
const reportContainer = document.getElementById('reportContainer');
const failurePanel = document.getElementById('failurePanel');
const viewFailedBtn = document.getElementById('viewFailedBtn');

// Initialize Bootstrap tabs
const resultsTab = new bootstrap.Tab(document.getElementById('all-tab'));

// Pretty print JSON function

function prettyPrintJson(json) {
    try {
        if (typeof json === 'string') {
            json = JSON.parse(json);
        }
        return JSON.stringify(json, null, 2);
    } catch (e) {
        return json;
    }
}

// Fallback for any value that would otherwise render as "undefined" / blank
function safe(value, fallback = 'N/A') {
    return (value === undefined || value === null || value === '') ? fallback : value;
}

// Prevent uploaded report content (names, urls, assertion text) from being
// interpreted as HTML when injected via innerHTML.
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Newman's JSON reporter stores the response body as a raw Buffer
// ({ type: "Buffer", data: [...] }), not as a string like the Postman App
// export does - and different Newman/Node versions have been seen to
// serialize that buffer slightly differently (a wrapped {type,data} object,
// a bare array of byte values, a numeric-keyed object, or occasionally a
// base64 string). Try each shape in turn instead of assuming just one.
function decodeResponseBody(response, result) {
    if (!response && !result) return '';
    if (typeof response?.body === 'string' && response.body) return response.body;
    if (typeof result?.responseBody === 'string' && result.responseBody) return result.responseBody;

    const stream = response?.stream;
    if (stream !== undefined && stream !== null) {
        try {
            if (stream.type === 'Buffer' && Array.isArray(stream.data)) {
                return new TextDecoder('utf-8').decode(new Uint8Array(stream.data));
            }
            if (Array.isArray(stream)) {
                return new TextDecoder('utf-8').decode(new Uint8Array(stream));
            }
            if (typeof stream === 'object') {
                // Numeric-keyed object form, e.g. {"0":123,"1":34,...}
                const byteKeys = Object.keys(stream).filter(k => /^\d+$/.test(k));
                if (byteKeys.length) {
                    const bytes = byteKeys.sort((a, b) => Number(a) - Number(b)).map(k => stream[k]);
                    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
                }
            }
            if (typeof stream === 'string' && stream) {
                try {
                    return atob(stream); // base64 case
                } catch (e) {
                    return stream; // plain text fallback
                }
            }
        } catch (e) {
            return '(unable to decode response body: ' + e.message + ')';
        }
    }

    // Some exports (or programmatic Newman runs) attach a parsed body under
    // response.text / response.json instead of a raw stream.
    if (typeof response?.text === 'string' && response.text) return response.text;
    if (response?.json) {
        try { return JSON.stringify(response.json, null, 2); } catch (e) { /* fall through */ }
    }

    return '';
}

// Postman/Newman request bodies come in several "mode" shapes depending on
// how the request was authored (raw JSON, form fields, urlencoded, GraphQL).
// Grabbing only `.raw` silently drops the other three, which is the most
// likely reason "Request" showed blank for requests that do have a body.
function extractRequestBody(request) {
    const body = request?.body;
    if (!body) return '';
    if (typeof body === 'string') return body;

    if (body.mode === 'raw' && typeof body.raw === 'string') return body.raw;
    if (body.mode === 'urlencoded' && Array.isArray(body.urlencoded)) {
        return body.urlencoded.map(p => `${p.key}=${p.value ?? ''}`).join('&');
    }
    if (body.mode === 'formdata' && Array.isArray(body.formdata)) {
        return body.formdata.map(p => `${p.key}: ${p.value ?? '(file)'}`).join('\n');
    }
    if (body.mode === 'graphql' && body.graphql) {
        try { return JSON.stringify(body.graphql, null, 2); } catch (e) { /* fall through */ }
    }
    if (typeof body.raw === 'string' && body.raw) return body.raw;

    // Unrecognized shape - show the raw object rather than nothing, so it's
    // at least visible that a body exists and what it looks like.
    try {
        return JSON.stringify(body, null, 2);
    } catch (e) {
        return '';
    }
}

// Detect which of the two supported export formats was uploaded, since
// Postman's Collection Runner export and Newman's JSON reporter output use
// different top-level shapes for the same kind of run.
function detectReportFormat(data) {
    if (data && data.run && Array.isArray(data.run.executions)) return 'newman';
    if (data && Array.isArray(data.results)) return 'postman';
    return 'unknown';
}

function toggleVisibility(elementId, iconElement = null) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const isHidden = element.style.display === 'none';
    if (isHidden) {
        element.style.display = '';
        if (iconElement) {
            iconElement.classList.remove('fa-eye');
            iconElement.classList.add('fa-eye-slash');
            iconElement.parentElement.setAttribute('title', 'Hide endpoint');
        }
    } else {
        element.style.display = 'none';
        if (iconElement) {
            iconElement.classList.remove('fa-eye-slash');
            iconElement.classList.add('fa-eye');
            iconElement.parentElement.setAttribute('title', 'Show endpoint');
        }
    }
}

function renderTests(filtered, containerId) {
    const resultsEl = document.getElementById(containerId);
    if (!resultsEl) return;
    
    if (filtered.length === 0) {
        resultsEl.innerHTML = '<div class="alert alert-info text-center">No tests match the current filter.</div>';
        return;
    }

    resultsEl.innerHTML = filtered.map((item, index) => {
        const hasFailed = item.assertions.some(a => a.status === 'failed');
        const statusClass = hasFailed ? 'failed' : 'passed';
        const statusText = hasFailed ? 'FAIL' : 'PASS';

        return `
        <div class="test-card ${statusClass}">
            <div class="d-flex justify-content-between align-items-center">
                <div class="test-name">${escapeHtml(safe(item.name, 'Unnamed Request'))}</div>
                <div class="test-status ${statusClass}">${statusText}</div>
            </div>
            
            <div class="endpoint d-flex align-items-center mt-2">
                <strong class="me-2">${escapeHtml(safe(item.method, 'ENDPOINT'))}</strong>
                <span id="${containerId}-url-${index}" class="flex-grow-1">${escapeHtml(safe(item.url, '(no url)'))}</span>
                <button class="btn btn-sm p-0 ms-2 btn-toggle-visibility" onclick="toggleVisibility('${containerId}-url-${index}', this.querySelector('i'))" title="Hide endpoint">
                    <i class="fas fa-eye-slash"></i>
                </button>
            </div>

            <div class="small mt-1">
                <strong>Response:</strong>
                <span class="text-muted">${escapeHtml(safe(item.responseCode))} ${escapeHtml(safe(item.responseStatus, ''))} | Time: ${safe(item.time, 0)}ms</span>
            </div>

            <div class="mt-3">
                ${(item.assertions.length > 0) ? item.assertions.map(assertion => `
                <div class="assertion ${assertion.status}">
                    <div class="d-flex justify-content-between">
                        <span>${escapeHtml(safe(assertion.name, 'Unnamed assertion'))}</span>
                        <strong>${assertion.status.toUpperCase()}</strong>
                    </div>
                </div>`).join('') : '<div class="alert alert-secondary p-2">No assertions found for this request.</div>'}
            </div>

            ${(item.requestBody || item.responseBody) ? `
            <div class="mt-3">
                <button class="btn btn-outline-primary btn-sm" onclick="openTestDetail(${item._id})">
                    <i class="fas fa-magnifying-glass me-1"></i>View Request / Response
                </button>
            </div>
            ` : ''}
        </div>
        `;
    }).join('');
}

// Looks up a rendered test by its stable _id (assigned once in renderReport)
// so the detail modal works no matter which tab (all/passed/failed) the
// click came from. Only shows the request/response bodies - status,
// assertions, method, url, etc. are already visible on the card itself, so
// repeating them here was pure duplication.
function openTestDetail(id) {
    const test = window.testsById ? window.testsById[id] : null;
    if (!test) return;

    document.getElementById('testDetailTitle').textContent = safe(test.name, 'Unnamed Request');

    document.getElementById('requestBodyContent').textContent =
        test.requestBody ? prettyPrintJson(test.requestBody) : '(no request body)';
    document.getElementById('responseBodyContent').textContent =
        test.responseBody ? prettyPrintJson(test.responseBody) : '(no response body)';

    new bootstrap.Modal(document.getElementById('testDetailModal')).show();
}

// Overall run status, computed from the real assertion counts of the loaded run.
// Both cut-offs are user-adjustable (saved in this browser), so the verdict follows
// the team's own standard for the test instead of a fixed 5% / 20%.
function calculateStatus(passed, failed, warnBelow = 5, criticalFrom = 20) {
  const total = passed + failed;
  if (total === 0) return { status: 'NO DATA', severity: 'muted', rate: 0 };
  const rate = (failed / total) * 100;
  if (failed === 0) return { status: 'PASS', severity: 'success', rate };
  if (rate < warnBelow) return { status: 'WARNING', severity: 'warning', rate };
  if (rate < criticalFrom) return { status: 'FAIL', severity: 'danger', rate };
  return { status: 'CRITICAL', severity: 'critical', rate };
}

let lastCounts = { passed: 0, failed: 0 };
function loadThreshold(key, fallback) {
  try { const v = parseFloat(localStorage.getItem(key)); return isNaN(v) ? fallback : v; } catch (e) { return fallback; }
}
function updateOverallStatus() {
  const warnEl = document.getElementById('warnBelow'), critEl = document.getElementById('criticalFrom');
  const warnBelow = parseFloat(warnEl.value), criticalFrom = parseFloat(critEl.value);
  const st = calculateStatus(lastCounts.passed, lastCounts.failed,
    isNaN(warnBelow) ? 5 : warnBelow, isNaN(criticalFrom) ? 20 : criticalFrom);
  const badge = document.getElementById('overallStatusBadge');
  badge.textContent = st.status;
  badge.className = 'badge status-' + st.severity;
  document.getElementById('overallStatusText').textContent = st.status === 'NO DATA'
    ? 'No assertions found in this run.'
    : `${lastCounts.failed} of ${lastCounts.passed + lastCounts.failed} assertions failed (${st.rate.toFixed(1)}%)`;
  document.getElementById('overallStatus').style.display = '';
  try { localStorage.setItem('warnBelow', warnEl.value); localStorage.setItem('criticalFrom', critEl.value); } catch (e) {}
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('warnBelow').value = loadThreshold('warnBelow', 5);
  document.getElementById('criticalFrom').value = loadThreshold('criticalFrom', 20);
  ['warnBelow', 'criticalFrom'].forEach(id => document.getElementById(id).addEventListener('input', updateOverallStatus));
});

// Postman App export ("Save as JSON" from the Collection Runner) and
// Newman's `-r json` reporter describe the same kind of run with different
// field names, so each gets its own extractor instead of one function
// guessing at both shapes. Both return the same normalized object so
// everything downstream (renderTests, KPIs, charts, the detail modal) only
// ever has to deal with one schema.
function extractUrl(request, fallback) {
    if (!request || !request.url) return fallback || '';
    const url = request.url;
    if (typeof url === 'string') return url;
    // Newman/Postman collection SDK url objects don't stringify usefully via
    // template literals - use .raw, or rebuild from parts, before falling back.
    if (url.raw) return url.raw;
    if (Array.isArray(url.host)) {
        const host = url.host.join('.');
        const path = Array.isArray(url.path) ? '/' + url.path.join('/') : '';
        return host ? `${host}${path}` : fallback || '';
    }
    return fallback || '';
}

function extractPostmanResults(data) {
    const results = data.results || [];
    return results.map((result, idx) => {
        const assertionsRaw = result.assertions || result.tests || {};
        const assertions = Array.isArray(assertionsRaw)
            ? assertionsRaw.map(a => ({
                name: a.assertion || a.name || 'Unnamed assertion',
                status: a.error ? 'failed' : 'passed'
            }))
            : Object.entries(assertionsRaw).map(([key, value]) => ({
                name: key,
                status: value ? 'passed' : 'failed'
            }));

        const request = result.request || {};
        const response = result.response || {};
        const method = (request.method || result.method || 'ENDPOINT').toString().trim().toUpperCase();

        return {
            _id: idx,
            name: result.name || request.name || 'Unnamed Request',
            url: extractUrl(request, result.url),
            method: method === 'REQUEST URL:' ? 'ENDPOINT' : method,
            time: response.responseTime ?? result.time ?? 0,
            responseCode: response.code ?? result.responseCode?.code ?? 'N/A',
            responseStatus: response.status ?? result.responseCode?.name ?? '',
            assertions: assertions,
            requestBody: extractRequestBody(request),
            responseBody: decodeResponseBody(response, result)
        };
    });
}

function extractNewmanResults(data) {
    const executions = data.run?.executions || [];
    return executions.map((execution, idx) => {
        // Newman lists every assertion with an `error` key only present on
        // failures - unlike the Postman App export, it never gives clean
        // expected/actual values, only the assertion's error message.
        const assertionsRaw = execution.assertions || [];
        const assertions = assertionsRaw.map(a => ({
            name: a.assertion || 'Unnamed assertion',
            status: a.error ? 'failed' : 'passed',
            errorMessage: a.error?.message || null
        }));

        const request = execution.request || {};
        const response = execution.response || {};
        // The request/item name lives under execution.item.name in Newman's
        // JSON reporter, not execution.name - that mismatch is what produced
        // "Unnamed Request" for every row on a Newman upload.
        const name = execution.item?.name || request.name || 'Unnamed Request';
        const method = (request.method || 'ENDPOINT').toString().trim().toUpperCase();

        return {
            _id: idx,
            name,
            url: extractUrl(request, ''),
            method,
            time: response.responseTime ?? 0,
            responseCode: response.code ?? 'N/A',
            responseStatus: response.status ?? '',
            assertions,
            requestBody: extractRequestBody(request),
            responseBody: decodeResponseBody(response, null)
        };
    });
}

function extractRunMeta(data, format) {
    if (format === 'newman') {
        return {
            collectionName: data.collection?.info?.name || 'Untitled Collection',
            environmentName: data.environment?.name || null,
            runDate: data.run?.timings?.started ? new Date(data.run.timings.started).toLocaleString() : null,
            formatLabel: 'Newman CLI'
        };
    }
    if (format === 'postman') {
        return {
            collectionName: data.name || data.collection?.info?.name || 'Untitled Collection',
            environmentName: data.environment?.name || null,
            runDate: null,
            formatLabel: 'Postman App Export'
        };
    }
    return { collectionName: 'Untitled Collection', environmentName: null, runDate: null, formatLabel: 'Unknown' };
}

function renderReport(data) {
    const format = detectReportFormat(data);

    if (format === 'unknown') {
        alert('Could not find test results in the provided JSON. Please provide a valid Postman Collection Runner export or a Newman JSON reporter output.');
        return;
    }

    allTests = format === 'newman' ? extractNewmanResults(data) : extractPostmanResults(data);

    if (allTests.length === 0) {
        alert('The report parsed successfully but contained no requests. Please check the file and try again.');
        return;
    }

    // Make every test look-up-able by a stable id regardless of which tab
    // (all/passed/failed) it's rendered under - the detail modal reads
    // from this map.
    window.testsById = {};
    allTests.forEach(t => { window.testsById[t._id] = t; });

    const meta = extractRunMeta(data, format);
    document.getElementById('reportTitle').textContent = meta.collectionName;

    const metaBar = document.getElementById('runMetaBar');
    if (metaBar) {
        document.getElementById('metaFormatBadge').textContent = meta.formatLabel;
        document.getElementById('metaEnvironmentName').textContent = meta.environmentName || 'No environment';
        const runDateEl = document.getElementById('metaRunDate');
        if (meta.runDate) {
            runDateEl.textContent = meta.runDate;
            runDateEl.parentElement.style.display = '';
        } else {
            runDateEl.parentElement.style.display = 'none';
        }
        metaBar.style.display = '';
    }

    // Filter tests
    passedTests = allTests.filter(t => !t.assertions.some(a => a.status === 'failed'));
    failedTests = allTests.filter(t => t.assertions.some(a => a.status === 'failed'));

    // Calculate metrics
    const totalTests = allTests.length;
    const totalAssertions = allTests.reduce((sum, test) => sum + test.assertions.length, 0);
    const failedAssertions = allTests.reduce((sum, test) => sum + test.assertions.filter(a => a.status === 'failed').length, 0);
    const passedAssertions = totalAssertions - failedAssertions;
    const totalTime = allTests.reduce((sum, r) => sum + r.time, 0);
    const avgTime = totalTests > 0 ? (totalTime / totalTests).toFixed(0) : 0;
    
    // Calculate percentages
    const passedPercentage = totalAssertions > 0 ? ((passedAssertions / totalAssertions) * 100).toFixed(1) : 0;
    const failedPercentage = totalAssertions > 0 ? ((failedAssertions / totalAssertions) * 100).toFixed(1) : 0;
    
    // Calculate status
    lastCounts = { passed: passedAssertions, failed: failedAssertions };
    updateOverallStatus();

    // Find fastest and slowest tests
    const fastestTest = allTests.length > 0 ? 
        Math.min(...allTests.map(t => t.time)) : 0;
    const slowestTest = allTests.length > 0 ? 
        Math.max(...allTests.map(t => t.time)) : 0;

    // Update UI
    document.getElementById('totalTests').textContent = totalTests;
    document.getElementById('totalAssertions').textContent = totalAssertions;
    document.getElementById('passedTests').innerHTML = `${passedAssertions} <small>(${passedPercentage}%)</small>`;
    document.getElementById('failedTests').innerHTML = `${failedAssertions} <small>(${failedPercentage}%)</small>`;
    document.getElementById('executionTime').textContent = `${(totalTime / 1000).toFixed(2)}s`;
    document.getElementById('avgTime').textContent = `${avgTime}ms`;
    document.getElementById('fastestTest').textContent = `${fastestTest}ms`;
    document.getElementById('slowestTest').textContent = `${slowestTest}ms`;
    
    // Update KPI cards
    document.getElementById('totalRequests').textContent = totalTests;
    document.getElementById('successRate').textContent = `${passedPercentage}%`;
    document.getElementById('failedTestsCount').textContent = failedTests.length;
    document.getElementById('avgResponseTime').textContent = `${avgTime}ms`;

    // Update failure panel
    if (failedTests.length > 0) {
        failurePanel.style.display = 'block';
        document.getElementById('failureCount').textContent = 
            `${failedTests.length} test${failedTests.length > 1 ? 's' : ''} failed (${failedPercentage}% failure rate)`;
    } else {
        failurePanel.style.display = 'none';
    }

    // Render all test tabs
    renderTests(allTests, 'testResultsAll');
    renderTests(passedTests, 'testResultsPassed');
    renderTests(failedTests, 'testResultsFailed');

    // Initialize charts
    initCharts();
    
    // Show the report and hide the upload area
    reportContainer.style.display = 'block';
    jsonUploadArea.style.display = 'none';
}

function initCharts() {
    try {
        // Response Time Chart
        const responseTimeCtx = document.getElementById('responseTimeChart');
        if (responseTimeCtx) {
            new Chart(responseTimeCtx.getContext('2d'), {
                type: 'line',
                data: {
                    labels: allTests.map((_, i) => `Test ${i+1}`),
                    datasets: [{
                        label: 'Response Time (ms)',
                        data: allTests.map(test => test.time),
                        borderColor: 'rgba(75, 192, 192, 1)',
                        backgroundColor: 'rgba(75, 192, 192, 0.1)',
                        borderWidth: 1,
                        tension: 0.1,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false, // Important for fixed size
                    aspectRatio: 2, // Width to height ratio
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Response Time (ms)'
                            }
                        },
                        x: {
                            ticks: {
                                maxRotation: 45,
                                minRotation: 45,
                                autoSkip: true,
                                maxTicksLimit: 10
                            },
                            title: {
                                display: true,
                                text: 'Test Sequence'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'top',
                        }
                    }
                }
            });
        }

        // Status Code Chart
        const statusCodeCtx = document.getElementById('statusCodeChart');
        if (statusCodeCtx) {
            const statusCodes = {};
            allTests.forEach(test => {
                const code = test.responseCode;
                statusCodes[code] = (statusCodes[code] || 0) + 1;
            });

            const backgroundColors = [
                'rgba(54, 162, 235, 0.7)',
                'rgba(75, 192, 192, 0.7)',
                'rgba(255, 206, 86, 0.7)',
                'rgba(153, 102, 255, 0.7)',
                'rgba(255, 159, 64, 0.7)'
            ];

            new Chart(statusCodeCtx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: Object.keys(statusCodes),
                    datasets: [{
                        label: 'Count',
                        data: Object.values(statusCodes),
                        backgroundColor: backgroundColors,
                        borderColor: backgroundColors.map(c => c.replace('0.7', '1')),
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false, // Important for fixed size
                    aspectRatio: 2, // Width to height ratio
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Request Count'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Status Code'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        }
                    }
                }
            });
        }
    } catch (error) {
        console.error('Error initializing charts:', error);
    }
}

// Renders the report to a proper paginated PDF via html2canvas + jsPDF,
// instead of window.print() - the browser print engine was inconsistent
// about page breaks and cut charts/tables off mid-row across browsers.
async function exportReportToPDF() {
    const button = document.getElementById('exportPdfBtn');
    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Generating PDF...';

    try {
        const reportEl = document.getElementById('reportContainer');
        const canvas = await html2canvas(reportEl, {
            scale: 2,
            useCORS: true,
            backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff'
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'pt', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const imgWidth = pageWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;

        const imgData = canvas.toDataURL('image/png');
        let heightLeft = imgHeight;
        let position = 0;

        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;

        while (heightLeft > 0) {
            position -= pageHeight;
            pdf.addPage();
            pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;
        }

        pdf.save(`postman-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
        console.error('PDF export failed:', err);
        alert('Could not generate the PDF. Please try again.');
    } finally {
        button.disabled = false;
        button.innerHTML = originalHtml;
    }
}

// =============================================================
// EXPORT REPORT AS STANDALONE HTML
// =============================================================
// - Preserves the current report HTML
// - Embeds all linked CSS into the exported file
// - Converts Chart.js canvases to static images
// - Embeds test data
// - Removes the JSON upload area
// - Keeps the original app.js reference for functionality
// =============================================================

async function exportReportToHTML() {

    const button = document.getElementById('exportHtmlBtn');

    const originalHtml = button
        ? button.innerHTML
        : '';

    try {

        // ---------------------------------------------------------
        // 1. Show export progress
        // ---------------------------------------------------------

        if (button) {
            button.disabled = true;
            button.innerHTML =
                '<i class="fas fa-spinner fa-spin me-2"></i>Exporting HTML...';
        }


        // ---------------------------------------------------------
        // 2. Clone the current document
        // ---------------------------------------------------------

        const docClone =
            document.documentElement.cloneNode(true);


        // ---------------------------------------------------------
        // 3. Convert Chart.js canvases to images
        // ---------------------------------------------------------

        const liveCanvases = [
            document.getElementById('responseTimeChart'),
            document.getElementById('statusCodeChart')
        ];

        const clonedCanvases = [
            docClone.querySelector('#responseTimeChart'),
            docClone.querySelector('#statusCodeChart')
        ];

        liveCanvases.forEach((liveCanvas, index) => {

            const clonedCanvas =
                clonedCanvases[index];

            if (!liveCanvas || !clonedCanvas) {
                return;
            }

            try {

                const img =
                    document.createElement('img');

                img.src =
                    liveCanvas.toDataURL('image/png');

                img.style.width = '100%';
                img.style.height = 'auto';
                img.style.display = 'block';

                clonedCanvas.replaceWith(img);

            } catch (error) {

                console.warn(
                    'Could not export chart:',
                    error
                );
            }
        });


        // ---------------------------------------------------------
        // 4. Remove elements that should not appear in report
        // ---------------------------------------------------------

        docClone
            .querySelector('#jsonUploadArea')
            ?.remove();


        // ---------------------------------------------------------
        // Remove file input
        // ---------------------------------------------------------

        docClone
            .querySelector('#fileInput')
            ?.remove();


        // ---------------------------------------------------------
        // 5. Embed ALL CSS files
        // ---------------------------------------------------------

        const stylesheetLinks =
            Array.from(
                docClone.querySelectorAll(
                    'link[rel="stylesheet"]'
                )
            );


        for (const link of stylesheetLinks) {

            const href =
                link.getAttribute('href');

            if (!href) {
                continue;
            }

            try {

                // Convert relative CSS path to absolute URL
                const cssUrl =
                    new URL(
                        href,
                        document.baseURI
                    ).href;


                const response =
                    await fetch(cssUrl);


                if (!response.ok) {

                    console.warn(
                        `Unable to load stylesheet: ${cssUrl}`
                    );

                    continue;
                }


                const cssText =
                    await response.text();


                // Create the style element from the
                // ORIGINAL document, not docClone.
                const style =
                    document.createElement('style');


                style.setAttribute(
                    'data-exported-from',
                    href
                );


                style.textContent =
                    `\n/* Embedded stylesheet: ${href} */\n${cssText}\n`;


                // Replace the external <link>
                // with the embedded <style>
                link.replaceWith(style);


            } catch (error) {

                console.warn(
                    `Could not embed stylesheet: ${href}`,
                    error
                );
            }
        }


        // ---------------------------------------------------------
        // 6. Embed test data
        // ---------------------------------------------------------

        const dataScript =
            document.createElement('script');

        dataScript.textContent = `
window.testsById = ${JSON.stringify(
    window.testsById || {}
)};
`;


        // Find app.js
        const appScriptTag =
            docClone.querySelector(
                'script[src="script/app.js"]'
            );


        if (appScriptTag) {

            appScriptTag.parentNode.insertBefore(
                dataScript,
                appScriptTag
            );

        } else {

            docClone
                .querySelector('body')
                ?.appendChild(dataScript);
        }


        // ---------------------------------------------------------
        // 7. Mark report as exported
        // ---------------------------------------------------------

        const exportMarker =
            document.createElement('meta');

        exportMarker.name =
            'report-export';

        exportMarker.content =
            'Postman/Newman HTML Report';


        docClone
            .querySelector('head')
            ?.appendChild(exportMarker);


        // ---------------------------------------------------------
        // 8. Generate final HTML
        // ---------------------------------------------------------

        const html =
            '<!DOCTYPE html>\n' +
            docClone.outerHTML;


        // ---------------------------------------------------------
        // 9. Create downloadable file
        // ---------------------------------------------------------

        const blob =
            new Blob(
                [html],
                {
                    type: 'text/html;charset=utf-8'
                }
            );


        const url =
            URL.createObjectURL(blob);


        const downloadLink =
            document.createElement('a');


        downloadLink.href =
            url;


        downloadLink.download =
            `postman-report-${new Date()
                .toISOString()
                .slice(0, 10)}.html`;


        document.body.appendChild(
            downloadLink
        );


        downloadLink.click();


        downloadLink.remove();


        // Give browser time to start download
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);


    } catch (error) {

        console.error(
            'HTML export failed:',
            error
        );


        alert(
            'Could not export the HTML report. Check the browser console for details.'
        );


    } finally {

        // ---------------------------------------------------------
        // 10. Restore export button
        // ---------------------------------------------------------

        if (button) {

            button.disabled = false;

            button.innerHTML =
                originalHtml;
        }
    }
}

function handleFile(file) {
    if (!file || !file.type.includes('json')) {
        alert('Please upload a valid JSON file.');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (event) {
        try {
            const json = JSON.parse(event.target.result);
            renderReport(json);
        } catch (e) {
            alert('Error parsing JSON file. Please ensure it is well-formed.');
            console.error("JSON Parse Error:", e);
        }
    };
    reader.readAsText(file);
}

// Event Listeners
jsonUploadArea.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

jsonUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    jsonUploadArea.classList.add('dragover');
});

jsonUploadArea.addEventListener('dragleave', () => {
    jsonUploadArea.classList.remove('dragover');
});

jsonUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    jsonUploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

document.getElementById('pasteJsonBtn').addEventListener('click', () => {
    const pastedData = prompt('Paste your Postman JSON report data here:');
    if (pastedData) {
        try {
            const json = JSON.parse(pastedData);
            renderReport(json);
        } catch (e) {
            alert('Invalid JSON data pasted.');
            console.error("JSON Paste Error:", e);
        }
    }
});

viewFailedBtn.addEventListener('click', () => {
    const failedTab = new bootstrap.Tab(document.getElementById('failed-tab'));
    failedTab.show();
});

// Theme switching function
function switchTheme(theme) {
  const html = document.documentElement;
  const lightBtn = document.querySelector('.theme-btn[onclick*="light"]');
  const darkBtn = document.querySelector('.theme-btn[onclick*="dark"]');
  
  // Remove all theme classes first
  html.classList.remove('light-theme', 'dark-theme');
  
  if (theme === 'dark') {
    html.classList.add('dark-theme');
    html.setAttribute('data-theme', 'dark');
    lightBtn?.classList.remove('active');
    darkBtn?.classList.add('active');
    localStorage.setItem('theme', 'dark');
  } else {
    html.classList.add('light-theme');
    html.removeAttribute('data-theme');
    darkBtn?.classList.remove('active');
    lightBtn?.classList.add('active');
    localStorage.setItem('theme', 'light');
  }
}

// Initialize theme on load
function initializeTheme() {
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  // Check for saved theme first, then system preference
  const themeToSet = savedTheme || (prefersDark ? 'dark' : 'light');
  switchTheme(themeToSet);
}

// Call this when page loads
document.addEventListener('DOMContentLoaded', initializeTheme);

// Watch for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  if (!localStorage.getItem('theme')) {
    switchTheme(e.matches ? 'dark' : 'light');
  }
});


// Fail test redirect
function animatedScrollTo(targetY, duration = 600) {
    const startY = window.pageYOffset;
    const distanceY = targetY - startY;
    let startTime = null;

    function easeInOutQuad(t) {
      return t < 0.5
        ? 2 * t * t
        : -1 + (4 - 2 * t) * t;
    }

    function scroll(currentTime) {
      if (!startTime) startTime = currentTime;
      const timeElapsed = currentTime - startTime;
      const progress = Math.min(timeElapsed / duration, 1);
      const ease = easeInOutQuad(progress);
      window.scrollTo(0, startY + distanceY * ease);

      if (progress < 1) {
        requestAnimationFrame(scroll);
      }
    }

    requestAnimationFrame(scroll);
  }

  document.getElementById("viewFailedBtn").addEventListener("click", function () {
    const failedTab = document.getElementById("failed-tab");
    const offsetTop = failedTab.getBoundingClientRect().top + window.pageYOffset - 100; // Adjust offset if needed

    // Smooth scroll to the failed tab button
    animatedScrollTo(offsetTop, 700); // scroll duration = 700ms

    // Activate the tab after short delay (can be instant too)
    setTimeout(() => {
      failedTab.click();
    }, 750); // Match or slightly exceed scroll duration
  });


# Modifications in this copy

Cloned from https://github.com/fidelanders/postman-html-report on 2026-09-25.
Changes made on top of the original `main` branch:

## 1. Fixed Newman JSON reports rendering `undefined` fields
`script/app.js` previously parsed Postman App exports and Newman CLI exports
with one best-effort function that guessed at field names. That guessing
broke silently on Newman's actual JSON reporter shape:

- Request/test names come from `execution.item.name` in Newman, not
  `execution.name` — every row rendered as "Unnamed Request".
- `request.url` is an object (`{ raw, host, path, ... }`), not a string —
  calling `.toString()` on it doesn't return the URL.
- The response body is a raw Buffer (`{ type: "Buffer", data: [...] }`) in
  Newman's output, not a plain string — it needs decoding, otherwise you get
  `[object Object]` or a wall of byte numbers instead of the body.

Replaced this with:
- `detectReportFormat()` — identifies Postman App export vs. Newman CLI
  output from the JSON shape.
- `extractPostmanResults()` / `extractNewmanResults()` — one explicit adapter
  per format, both returning the same normalized test object.
- `decodeResponseBody()` — decodes Newman's Buffer stream into readable text.
- `extractUrl()` — handles both string URLs and Postman/Newman URL objects.
- `safe()` / `escapeHtml()` — used everywhere a value is written into the
  DOM, so a missing field shows "N/A" instead of the literal string
  "undefined", and uploaded report content can't be interpreted as HTML.

A quick correctness check for the Newman path is described in the PR/commit
notes; the fix was verified against a realistic `newman run -r json` sample
before packaging.

## 2. Added a failed/passed-test detail modal ("View Details")
Every request card in the results tabs now has a **View Details** button
that opens a modal showing:
- Pass/fail status, method, URL, response code, and response time
- The full list of assertions with pass/fail status
- The raw request body and response body (pretty-printed JSON where
  applicable)

This addresses the biggest usability gap for QA review — being able to see
*why* a request failed without leaving the report.

## 3. Added a run metadata bar
Under the header, a small bar now shows:
- The detected format (Postman App Export vs. Newman CLI)
- The environment name, when present in the report
- The run date/time, when present (Newman includes this; the Postman App
  export does not)

## 4. Widened request/response body extraction (empty Request/Response tabs)
The first pass only handled `body.raw` on the request side and one shape of
Newman's response `stream` on the response side. Reported as blank fields —
fixed by:

- `extractRequestBody()` now also handles `urlencoded`, `formdata`, and
  `graphql` request body modes, and falls back to showing the raw body
  object (rather than nothing) for any shape it doesn't specifically
  recognize.
- `decodeResponseBody()` now tries several serializations of the response
  stream (wrapped `{type:"Buffer",data:[...]}`, a bare byte array, a
  numeric-keyed object, and a base64 string) before giving up, and also
  checks `response.text` / `response.json` as alternate locations some
  tools use.

One important caveat that no amount of parsing can work around: **the
Postman App's own "Export Results" feature does not include request/response
bodies at all** — it's a lightweight pass/fail + timing summary. If you're
seeing blank Request/Response tabs on a file exported that way (rather than
from `newman run -r json`), that's a limitation of Postman's export, not
this tool's parser. The Request/Response tabs will only ever have content on
Newman-generated reports (or richer Postman exports, if any exist).

## 5. Real PDF export + new standalone HTML export
`window.print()` was replaced with an actual PDF export using `html2canvas` +
`jsPDF` (both were already listed in the README's tech stack, just never
wired up). It renders the report to a canvas and paginates it into a real
multi-page A4 PDF, so charts/tables no longer get cut off unpredictably the
way browser print engines were doing.

A second button, **Export HTML**, was added alongside it — it saves the
currently rendered report as a standalone `.html` file (charts are baked in
as static images since there's no JSON payload in the file to redraw them
from). If that exported file is later opened from the same folder as
`script/app.js` and `css/`, the theme toggle, hide-endpoint, and View
Details controls keep working because the parsed test data is re-embedded
inline; opened on its own, those controls are inert but every value, chart,
and body is still visible.

## 6. Removed duplication in the "View Details" modal
The modal's Assertions tab, status badge, and method/URL/response-time line
were exact repeats of what's already shown on the request card. The modal
now only shows the **Request** and **Response** tabs — the two things that
weren't already visible anywhere else. The card's separate "Show Response
Body" toggle (which duplicated the same content a second way) was removed
too; the button is now labeled "View Request / Response" and only appears
when there's actually a body to show.

## 7. Removed the "Slow Tests (>500ms)" tab
The hardcoded 500ms threshold was arbitrary and not configurable, so the tab
and its filtering logic were removed. The **Slowest Test** figure in the
Performance Summary panel was left in place — that's a plain computed stat
(the actual max response time in the run), not a fixed threshold, so it's a
different thing from what was asked to be removed. Flagging in case you'd
like that gone too.

## Not included in this pass
Sortable/searchable results table, folder/suite grouping, and a proper print
stylesheet (replacing `window.print()`) were discussed but not implemented
here — flagging so nothing is assumed done. Happy to do any of these next.

## 8. Test Report Studio: home page, JMeter report, new repo name

- Added a home page (`index.html`) with a card for each report type; the Postman report moved to `postman.html`.
- Added a JMeter CSV/JTL report (`jmeter.html`, `css/jmeter.css`) with load, stress, spike, soak and baseline/performance verdicts, a "What Failed" table by endpoint, and print/PDF and JSON export. `sample-jmeter.jtl` is included for trying it out.
- Added `script/report-types.js` (selector bar and registry for new report types) and `script/theme.js` (shared light/dark theme).
- JMeter fix: each time slice now keeps a response-time histogram (slice width doubles on very long runs to bound memory). Before this, per-slice p95/p99 were always 0, so spike recovery was reported almost instantly and soak latency drift was always 0%.
- JMeter fix: stress runs now also grade the whole-run error rate (pass up to 20%, warning up to 40%) instead of always passing; the breaking point is still reported. p95 for stress is measured before the breaking point.
- JMeter fix: runs of two hours or more are auto-detected as soak; spike recovery is measured from the end of the spike against the pre-spike baseline.
- Updated the repository name in the README, CONTRIBUTING.md, the home page and the Postman page header.
- JMeter: spike runs are now scored on the surge itself (slices with users at 50% of peak or more) instead of the whole run, so a long calm period can no longer hide a bad spike.
- JMeter: added **Export HTML**, a standalone offline report with the verdict, tables and charts as images. The JSON button is now `exportJsonBtn`.
- Added `tests/` (60 automated checks that run the real page in jsdom with generated JTL files) and a GitHub Actions workflow, `.github/workflows/tests.yml`.
- JMeter: added **Compare with baseline**. After a report is shown you can load an older run; the page adds "p95 vs baseline" and "Error rate vs baseline" checks to the verdict (default tolerance 10% on p95, adjustable), a metrics comparison table, a per-endpoint table (regression, improved, same, new, removed), an overlay chart of p95 over the run, and a warning when the two runs used very different load, length or endpoints. The comparison is included in the HTML and JSON exports.
- Internal: the JTL reader is now a reusable promise (`readJtl`), so two files can be read in one session.

## 9. Postman report review and fixes

- Requests that never completed (connection refused, DNS, timeout) or hit a script error are now **ERROR** and counted as failures. Before, they showed PASS and could leave the run looking healthy.
- Requests with no tests show **NO TESTS** and are not counted as passed. Skipped assertions show **SKIPPED**. Totals no longer include skipped assertions.
- Failed assertion messages from Newman are now shown on the request card.
- Captured and shown: request and response **headers**, folder path (from the collection tree), iteration number, response size, and legacy Postman request bodies (`rawModeData`).
- Request / Response viewer: headers table, body size, Copy and Download, and a display limit for very large bodies (the full body is still copied and downloaded). Request errors are shown in the viewer.
- Notices above the report when a file has no bodies or headers (with the Newman and Postman CLI options that include them), and when requests errored, have no tests or were skipped.
- Execution time uses the run's wall-clock time when the file has it; fastest and average times ignore requests that got no response.
- HTML export: embedded data can no longer be broken out of by `</script>` in a response body (this could truncate the report and run injected markup); `app.js` and the other scripts are inlined so the report works as a single offline file; the selector bar is removed.
- HTML export: new **Mask secrets** option (on by default) for passwords, tokens, API keys, cookies and Bearer values in bodies, headers and URLs, and an **Include bodies & headers** option.
- `.json` files with an empty browser MIME type are accepted. The unsupported-format message now explains how to produce a supported file from the Postman CLI.
- Tests: 19 Postman tests, including an end-to-end HTML export check.

## 10. PDF export rebuilt on the print engine

- **Export PDF** now opens the print dialog (choose "Save as PDF") instead of screenshotting the page and slicing it into A4 strips. Cards, charts and table rows are no longer cut across pages, any paper size works, text is selectable, and very long reports no longer hit browser canvas limits.
- While printing, charts are replaced with sharp images sized for the page, the light theme is forced (dark mode used to print unreadable text), and the tab bar, buttons, export options and selector bar are hidden. The tab you are viewing (All, Passed or Failed) is the one that prints.
- The default PDF file name comes from the page title: `Postman report - <collection> - <date>`. A short hint explains the "Save as PDF" step.
- Charts are now tracked and destroyed when a second report is loaded, instead of stacking on the same canvas.
- Removed the jsPDF and html2canvas dependencies. Ctrl+P / Cmd+P gets the same print layout.


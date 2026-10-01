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

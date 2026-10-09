const buf = s => ({ type: 'Buffer', data: [...Buffer.from(s, 'utf8')] });
const hdr = o => Object.entries(o).map(([key, value]) => ({ key, value }));
const exec = (i, o) => ({ id: 'e' + i, cursor: { iteration: o.iteration || 0, position: i, ref: 'r' + i }, item: { id: 'r' + i, name: o.name }, request: { method: o.method || 'GET', url: { raw: o.url, host: ['api', 'example', 'com'], path: ['v1', 'x'] }, header: hdr(o.reqHeaders || { 'Content-Type': 'application/json', Authorization: 'Bearer SECRET-TOKEN-123' }), body: o.body }, response: o.noResponse ? undefined : { code: o.code, status: o.status, responseTime: o.ms, header: hdr(o.resHeaders || { 'Content-Type': 'application/json' }), stream: buf(o.res || '') }, assertions: o.assertions || [], requestError: o.requestError });
exports.newman = {
  collection: { info: { name: 'Shop API' }, item: [{ name: 'Orders', item: [{ id: 'r1', name: 'Create order' }] }, { id: 'r0', name: 'Get product' }] }, environment: { name: 'staging' },
  run: {
    timings: { started: 1700000000000, completed: 1700000009000 },
    executions: [
      exec(0, { name: 'Get product', url: 'https://api.example.com/v1/products/1', code: 200, status: 'OK', ms: 120, res: '{"id":1,"name":"Pen"}', assertions: [{ assertion: 'status is 200' }] }),
      exec(1, { name: 'Create order', method: 'POST', url: 'https://api.example.com/v1/orders', code: 500, status: 'Internal Server Error', ms: 480, body: { mode: 'raw', raw: '{"sku":"A1","qty":2,"password":"hunter2"}' }, res: '{"error":"boom"}', assertions: [{ assertion: 'status is 201', error: { name: 'AssertionError', message: 'expected response to have status code 201 but got 500' } }, { assertion: 'has order id', error: { name: 'AssertionError', message: "expected undefined to be a number" } }] }),
      exec(2, { name: 'Health check (server down)', url: 'https://api.example.com/health', noResponse: true, requestError: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.1:443' }, assertions: [] }),
      exec(3, { name: 'Skipped checks', url: 'https://api.example.com/v1/skip', code: 200, status: 'OK', ms: 90, res: '{}', assertions: [{ assertion: 'only runs in prod', skipped: true }] }),
      exec(4, { name: 'No tests written', url: 'https://api.example.com/v1/notests', code: 404, status: 'Not Found', ms: 60, res: '{"detail":"nope"}', assertions: [] }),
      exec(5, { name: 'HTML page', url: 'https://api.example.com/page', code: 200, status: 'OK', ms: 70, res: '<html><body>hi</script><script>alert(1)</script></body></html>', assertions: [{ assertion: 'is html' }] }),
      exec(6, { name: 'Get product', iteration: 1, url: 'https://api.example.com/v1/products/2', code: 200, status: 'OK', ms: 130, res: '{"id":2}', assertions: [{ assertion: 'status is 200' }] }),
    ],
    failures: [{ error: { name: 'Error', message: 'connect ECONNREFUSED 10.0.0.1:443' }, source: { id: 'r2', name: 'Health check (server down)' }, cursor: { ref: 'r2' } }]
  }
};

exports.postmanApp = { name: 'Legacy run', results: [
  { name: 'Login', request: { method: 'POST', url: 'https://x.test/login', headers: 'Content-Type: application/json\nAuthorization: Bearer abc', rawModeData: '{"user":"a","password":"p"}' }, response: { code: 200, status: 'OK', responseTime: 50, body: '{"token":"t"}', headers: 'Content-Type: application/json' }, tests: { 'status ok': true } },
  { name: 'Bad', request: { method: 'GET', url: 'https://x.test/b' }, response: { code: 500, status: 'Err', responseTime: 10, body: 'oops' }, tests: { ok: false } }
] };
exports.noBodies = { results: [{ name: 'a', request: { method: 'GET', url: 'https://x.test/a' }, response: { code: 200, status: 'OK', responseTime: 5 }, tests: { t: true } }] };

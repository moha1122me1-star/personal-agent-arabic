// Smoke tests: build output, asset serving, security headers, auth gate, static checks.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

for (const f of ['app.js', 'sw.js', 'worker-source.js', 'dist/worker.js']) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });

const worker = (await import('../dist/worker.js')).default;
const call = (path, init, env = { ACCESS_TOKEN: 'x'.repeat(32), KV: {} }) => worker.fetch(new Request('https://t.test' + path, init), env);

let n = 0; const ok = (name) => console.log('ok', ++n, name);

for (const [path, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/app.js', 'text/javascript'], ['/app.css', 'text/css'], ['/sw.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon.svg', 'image/svg+xml']]) {
  const r = await call(path); assert.equal(r.status, 200, path); assert.ok(r.headers.get('content-type').startsWith(type), path);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  ok('asset ' + path);
}
assert.equal((await call('/nope')).status, 404); ok('unknown path 404');
assert.equal((await call('/api/state')).status, 401); ok('api requires token');
assert.equal((await call('/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401); ok('api rejects wrong token');
assert.equal((await call('/', { method: 'POST' })).status, 405); ok('POST to assets rejected');

// static checks on the UI
const html = readFileSync('index.html', 'utf8'), js = readFileSync('app.js', 'utf8'), css = readFileSync('app.css', 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
for (const m of js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) assert.ok(ids.has(m[1]), 'app.js uses missing element #' + m[1]);
ok('every $(id) in app.js exists in index.html');
assert.ok(!/style="/.test(html) && !/<script>[^<]/.test(html) && !/<style/.test(html), 'inline style/script would break CSP'); ok('no inline style/script (CSP-safe)');
assert.ok(!/https?:\/\/(fonts|cdn)/.test(html + css), 'external resources would break CSP'); ok('no external resources');
assert.ok(!/gemini_not_configured' \?/.test(js)); ok('no stale Gemini-only error text');
console.log(`\nall ${n} checks passed`);

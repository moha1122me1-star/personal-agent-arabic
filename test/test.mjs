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

// ---------- tool-level tests (runTool exposed through a temporary copy; production worker is untouched) ----------
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'agent-test-'));
writeFileSync(join(tmp, 'w.mjs'), readFileSync('dist/worker.js', 'utf8') + '\nexport { runTool, DECLS, APPROVAL_TOOLS, systemPrompt };\n');
const { runTool, DECLS, APPROVAL_TOOLS, systemPrompt } = await import(join(tmp, 'w.mjs'));

const store = new Map();
const KV = { async get(k, type) { const v = store.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
  const reply = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/repos/o/r')) return reply({ default_branch: 'main' });
  if (url.includes('/git/ref/heads/main')) return reply({ object: { sha: 'abc123' } });
  if (url.endsWith('/git/refs')) return reply({ ref: 'refs/heads/feat' }, 201);
  if (url.endsWith('/pulls') && init.method === 'POST') return reply({ html_url: 'https://github.com/o/r/pull/7', number: 7 }, 201);
  if (url.includes('/issues?')) return reply([{ number: 1, title: 'bug', state: 'open', user: { login: 'u' }, html_url: 'h', updated_at: 't' }, { number: 2, title: 'a pr', pull_request: {}, state: 'open' }]);
  if (url.includes('/comments')) return reply({ html_url: 'https://github.com/o/r/issues/1#c' }, 201);
  if (url.includes('/actions/runs')) return reply({ workflow_runs: [{ name: 'ci', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'u', created_at: 't' }] });
  if (url.includes('api.cloudflare.com') && url.endsWith('/workers/scripts')) return reply({ success: true, result: [{ id: 'my-agent', modified_on: 'm', created_on: 'c' }] });
  if (url.includes('/deployments')) return reply({ success: true, result: { deployments: [{ id: 'd1', created_on: 'c', source: 'wrangler', strategy: 'percentage', versions: [{ version_id: 'v1', percentage: 100 }] }] } });
  return reply({ message: 'not mocked: ' + url }, 404);
};
const env = { KV, GITHUB_TOKEN: 'ghp_test', PHONE_TOKEN: 'p', CF_API_TOKEN: 'cft', CF_ACCOUNT_ID: 'a'.repeat(32) };

// every declared tool has a handler, and write tools are approval-gated
const src = readFileSync('worker-source.js', 'utf8');
for (const d of DECLS) assert.ok(src.includes(`case '${d.name}'`), 'no handler for ' + d.name);
ok('every declared tool has a handler');
for (const w of ['gh_write_file', 'gh_create_issue', 'gh_create_branch', 'gh_create_pr', 'gh_comment', 'phone_command', 'phone_open_url', 'phone_open_app', 'send_webhook', 'delete_file']) assert.ok(APPROVAL_TOOLS.has(w), w + ' must need approval');
ok('all write/phone tools require approval');

// unapproved call only queues a pending approval and never touches the network
calls.length = 0; const pend = [];
let r = await runTool(env, 'gh_create_pr', { repo: 'o/r', title: 't', head: 'feat', base: 'main' }, { pendings: pend });
assert.equal(r.status, 'awaiting_user_approval'); assert.equal(pend.length, 1); assert.equal(calls.length, 0);
ok('gh_create_pr waits for approval without calling GitHub');

// validation
for (const [name, args] of [['gh_create_branch', { repo: 'o/r', branch: '../x' }], ['gh_create_branch', { repo: 'bad repo', branch: 'x' }], ['gh_create_pr', { repo: 'o/r', title: 't', head: 'a b', base: 'main' }], ['gh_comment', { repo: 'o/r', number: 0, body: 'x' }]]) assert.equal((await runTool(env, name, args, { pendings: [] })).error, 'bad_arguments', name);
assert.equal((await runTool(env, 'phone_open_url', { url: 'http://x.com' }, { pendings: [] })).error, 'bad_url');
assert.equal((await runTool(env, 'phone_open_url', { url: 'javascript:alert(1)' }, { pendings: [] })).error, 'bad_url');
assert.equal((await runTool(env, 'phone_open_app', { app: 'x; rm -rf /' }, { pendings: [] })).error, 'bad_arguments');
ok('invalid branches, repos, urls and app names are rejected');

// approved execution
calls.length = 0;
r = await runTool(env, 'gh_create_branch', { repo: 'o/r', branch: 'feat' }, { approved: true });
assert.deepEqual(r, { ok: true, branch: 'feat', from: 'main' });
assert.deepEqual(calls.at(-1).body, { ref: 'refs/heads/feat', sha: 'abc123' }); assert.equal(calls.at(-1).auth, 'Bearer ghp_test');
ok('gh_create_branch resolves default branch sha and creates ref');
r = await runTool(env, 'gh_create_pr', { repo: 'o/r', title: 'T', head: 'feat', base: 'main', body: 'b' }, { approved: true });
assert.equal(r.number, 7); assert.deepEqual(calls.at(-1).body, { title: 'T', head: 'feat', base: 'main', body: 'b' });
ok('gh_create_pr posts correct payload');
r = await runTool(env, 'gh_comment', { repo: 'o/r', number: 1, body: 'hi' }, { approved: true }); assert.ok(r.ok && calls.at(-1).url.endsWith('/issues/1/comments'));
ok('gh_comment posts to the issue');
r = await runTool(env, 'gh_list_issues', { repo: 'o/r', state: 'DROP TABLE' }); assert.equal(r.items.length, 1); assert.ok(calls.at(-1).url.includes('state=open'));
ok('gh_list_issues excludes PRs and sanitizes state');
r = await runTool(env, 'gh_workflow_runs', { repo: 'o/r' }); assert.equal(r.runs[0].conclusion, 'success');
ok('gh_workflow_runs reports build status');

// phone
r = await runTool(env, 'phone_open_url', { url: 'https://example.com/x' }, { approved: true }); assert.ok(r.ok);
r = await runTool(env, 'phone_open_app', { app: 'Instagram' }, { approved: true }); assert.ok(r.ok);
const q = JSON.parse(store.get('phoneq')); assert.deepEqual(q.map(x => [x.action, x.value]), [['open_url', 'https://example.com/x'], ['open_app', 'Instagram']]);
ok('phone commands are queued for the Tasker bridge');

// cloudflare (read only)
assert.equal((await runTool({ KV }, 'cf_workers', {})).error, 'cloudflare_not_configured');
r = await runTool(env, 'cf_workers', {}); assert.equal(r.workers[0].name, 'my-agent'); assert.equal(calls.at(-1).method, 'GET'); assert.equal(calls.at(-1).auth, 'Bearer cft');
r = await runTool(env, 'cf_deployments', { script: 'my-agent' }); assert.equal(r.deployments[0].versions[0].percentage, 100);
assert.equal((await runTool(env, 'cf_deployments', { script: '../x' })).error, 'bad_arguments');
ok('cloudflare tools are read-only, configured by secrets, and validate input');

// ---------- google (read only) ----------
const b64url = (str) => Buffer.from(str, 'utf8').toString('base64url');
const prevFetch = globalThis.fetch; const gcalls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); gcalls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body ? String(init.body) : null });
  const reply = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://oauth2.googleapis.com/token') return String(init.body).includes('refresh_token=good') ? reply({ access_token: 'at1', expires_in: 3600 }) : reply({ error: 'invalid_grant', error_description: 'expired' }, 400);
  if (url.includes('/calendar/v3/')) return reply({ items: [{ summary: 'اجتماع', start: { dateTime: '2026-10-24T10:00:00+02:00' }, end: { dateTime: '2026-10-24T11:00:00+02:00' } }] });
  if (url.includes('/gmail/v1/users/me/messages?')) return reply({ messages: [{ id: 'abc123def4' }] });
  if (url.includes('format=metadata')) return reply({ snippet: 'hello', labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'Hi' }, { name: 'Date', value: 'today' }] } });
  if (url.includes('format=full')) return reply({ payload: { headers: [{ name: 'Subject', value: 'S' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64url('<p>html</p>') } }, { mimeType: 'text/plain', body: { data: b64url('نص الرسالة') } }] } });
  if (url.includes('/drive/v3/files')) return reply({ files: [{ id: 'f1', name: 'خطة', mimeType: 'application/pdf', modifiedTime: 'm', webViewLink: 'w' }] });
  return reply({}, 404);
};
const genv = { KV, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'good' };
assert.equal((await runTool({ KV }, 'gmail_search', {})).error, 'google_not_configured'); ok('google tools report missing configuration');
r = await runTool(genv, 'google_calendar', { days: 999 }); assert.equal(r.events[0].title, 'اجتماع'); assert.ok(r.note);
assert.ok(gcalls.find(c => c.url.includes('calendar')).auth === 'Bearer at1'); ok('calendar uses refreshed access token and marks content as data');
r = await runTool(genv, 'gmail_search', { query: 'is:unread', max: 50 }); assert.deepEqual([r.messages[0].from, r.messages[0].subject, r.messages[0].unread], ['a@b.com', 'Hi', true]);
assert.ok(gcalls.some(c => c.url.includes('maxResults=10'))); ok('gmail_search returns metadata and caps results');
r = await runTool(genv, 'gmail_read', { id: 'abc123def4' }); assert.equal(r.text, 'نص الرسالة'); ok('gmail_read prefers plain text');
assert.equal((await runTool(genv, 'gmail_read', { id: '../../x' })).error, 'bad_arguments'); ok('gmail_read rejects unsafe ids');
r = await runTool(genv, 'drive_search', { query: "x' or name contains 'y" }); assert.equal(r.files[0].name, 'خطة');
assert.ok(!decodeURIComponent(gcalls.at(-1).url).includes("x' or")); ok('drive_search strips quotes from the query');
assert.equal(gcalls.filter(c => c.url === 'https://oauth2.googleapis.com/token').length, 1); ok('access token is cached (one refresh for all calls)');
for (const c of gcalls) assert.ok(c.method === 'GET' || c.url.includes('oauth2.googleapis.com')); ok('google calls are read-only (GET only)');
globalThis.fetch = prevFetch;

// concise-reply rules reach the model (foreground and background prompts)
for (const bg of [false, true]) { const sp = systemPrompt([], bg); assert.ok(sp.includes('ممنوع الجداول') && sp.includes('سطر أو سطرين')); }
assert.ok(systemPrompt(['يحب الاختصار'], false).includes('يحب الاختصار'));
ok('system prompt enforces short mobile-friendly replies and keeps memory');

console.log(`\nall ${n} checks passed`);

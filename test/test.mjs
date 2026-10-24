// Smoke tests: build output, asset serving, security headers, auth gate, static checks.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

for (const f of ['app.js', 'sw.js', 'worker-source.js', 'dist/worker.js']) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });

const worker = (await import('../dist/worker.js')).default;
const call = (path, init, env = { ACCESS_TOKEN: 'x'.repeat(32), KV: {} }) => worker.fetch(new Request('https://t.test' + path, init), env);

let n = 0; const ok = (name) => console.log('ok', ++n, name);

for (const [path, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/app.js', 'text/javascript'], ['/md.js', 'text/javascript'], ['/app.css', 'text/css'], ['/sw.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon.svg', 'image/svg+xml']]) {
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
for (const m of html.matchAll(/<script src="(\/[^"]+)"/g)) assert.equal((await call(m[1])).status, 200, m[1] + ' must be served'); ok('every <script src> in index.html is served by the worker');

// ---------- tool-level tests (runTool exposed through a temporary copy; production worker is untouched) ----------
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'agent-test-'));
writeFileSync(join(tmp, 'w.mjs'), readFileSync('dist/worker.js', 'utf8') + '\nexport { maybeSummarize, errInfo, runTool, agentModel, anthropicMessages, DECLS, APPROVAL_TOOLS, systemPrompt, openAiMessages, fromOpenAi, executeRun, newRun, initRun, resumeStalledRun, runSummary, pushAll };\n');
const mod = await import(join(tmp, 'w.mjs'));
const { maybeSummarize, errInfo, runTool, agentModel, anthropicMessages, DECLS, APPROVAL_TOOLS, systemPrompt, openAiMessages, fromOpenAi, executeRun, newRun, initRun, resumeStalledRun, runSummary } = mod;

const store = new Map();
const KV = { async get(k, type) { const v = store.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
const calls = [];
const groqQueue = [], groqBodies = [], anthQueue = [], anthBodies = [];
const sse = (events) => new Response(new ReadableStream({ start(c) { const te = new TextEncoder(); for (const e of events) c.enqueue(te.encode('data: ' + JSON.stringify(e) + '\n\n')); c.enqueue(te.encode('data: [DONE]\n\n')); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
  const reply = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('api.anthropic.com/v1/messages')) { anthBodies.push(JSON.parse(init.body)); const next = anthQueue.shift(); if (!next) return reply({ error: { type: 'x' } }, 500); return typeof next === 'number' ? reply({ error: { type: 'x' } }, next) : sse(next); }
  if (url.startsWith('https://html.duckduckgo.com/html/')) return new Response('<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">مثال &amp; عنوان</a><a class="result__snippet" href="x">ملخص <b>النتيجة</b></a></div><div class="result"><a class="result__a" href="https://example.org/b">ثان</a></div>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.includes('api.groq.com/openai/v1/chat/completions')) { groqBodies.push(JSON.parse(init.body)); const next = groqQueue.shift(); if (!next) return reply({ error: { message: 'no mock' } }, 500); return typeof next === 'number' ? reply({ error: { message: 'x' } }, next) : sse(next); }
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

// the prompt asks for depth that matches the question, Markdown formatting, and keeps saved memory
for (const bg of [false, true]) { const sp = systemPrompt([], bg); assert.ok(sp.includes('Markdown') && sp.includes('كتل كود') && sp.includes('search_web')); assert.equal(sp.includes('ممنوع الجداول'), false); assert.equal(sp.includes('أنت الآن تنفذ مهمة مجدولة'), bg); }
assert.ok(systemPrompt(['يحب الاختصار'], false).includes('يحب الاختصار'));
ok('system prompt allows rich Markdown answers, asks for verification, and keeps memory');

// parallel calls to the same tool must each get their own result (regression: ids used to collide)
{
  const msgs = openAiMessages({ systemInstruction: { parts: [{ text: 's' }] }, contents: [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { id: 'a' } }, cid: 'c1' }, { functionCall: { name: 'read_file', args: { id: 'b' } }, cid: 'c2' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { t: 'A' } }, cid: 'c1' }, { functionResponse: { name: 'read_file', response: { t: 'B' } }, cid: 'c2' }] },
    { role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }, { functionCall: { name: 'x', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'x', response: { n: 1 } } }, { functionResponse: { name: 'x', response: { n: 2 } } }] },
  ] });
  const tools = msgs.filter(m => m.role === 'tool');
  assert.deepEqual(tools.slice(0, 2).map(m => m.tool_call_id), ['c1', 'c2']);
  const ids = msgs.filter(m => m.tool_calls).at(-1).tool_calls.map(c => c.id);
  assert.deepEqual(tools.slice(2).map(m => m.tool_call_id), ids); assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(fromOpenAi({ response: 'مرحبا' }, 'workers_ai').candidates[0].content.parts, [{ text: 'مرحبا' }]);
}
ok('tool results map to their own call ids; Workers AI plain responses parse');

// ---------- streaming chat, background survival, resume ----------
const chatEnv = { ACCESS_TOKEN: 'x'.repeat(32), KV, GROQ_API_KEY: 'g' };
const bg = [];
const ctx = { waitUntil: (p) => bg.push(p) };
const authed = (path, init = {}) => mod.default.fetch(new Request('https://t.test' + path, { ...init, headers: { Authorization: 'Bearer ' + chatEnv.ACCESS_TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) } }), chatEnv, ctx);
const readEvents = async (res) => { const out = []; const rd = res.body.getReader(), td = new TextDecoder(); let buf = ''; for (;;) { const { done, value } = await rd.read(); if (done) break; buf += td.decode(value, { stream: true }); } for (const part of buf.split('\n\n')) for (const l of part.split('\n')) if (l.startsWith('data:')) out.push(JSON.parse(l.slice(5))); return out; };
const delta = (content) => ({ choices: [{ delta: { content } }] });
const toolDelta = (index, id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } }] } }] });

// 1) plain streamed answer
groqQueue.push([delta('مرحبا '), delta('بك **يا** صديقي')]);
let res = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'سلام' }) });
assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
let ev = await readEvents(res); await Promise.all(bg.splice(0));
assert.equal(ev[0].t, 'run'); assert.deepEqual(ev.filter(e => e.t === 'text').map(e => e.d), ['مرحبا ', 'بك **يا** صديقي']);
assert.equal(ev.at(-1).t, 'done'); assert.equal(ev.at(-1).reply, 'مرحبا بك **يا** صديقي');
assert.equal(groqBodies.at(-1).stream, true); assert.equal(groqBodies.at(-1).reasoning_effort, 'medium');
let hist = JSON.parse(store.get('hist')); assert.deepEqual(hist.map(h => h.role), ['user', 'model']); assert.equal(hist[1].text, 'مرحبا بك **يا** صديقي');
assert.equal(JSON.parse(store.get('run')).status, 'done');
ok('/api/chat streams text deltas as SSE, saves history and finishes the run');

// 2) two parallel tool calls with the same name, then the answer
groqQueue.push([delta('سأفحص. '), toolDelta(0, 'c1', 'list_files', ''), toolDelta(0, null, null, '{}'), toolDelta(1, 'c2', 'list_files', '{}')], [delta('لا توجد ملفات.')]);
res = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'ملفاتي؟' }) });
ev = await readEvents(res); await Promise.all(bg.splice(0));
assert.deepEqual(ev.filter(e => e.t === 'tools')[0].items.map(i => i.id), ['c1', 'c2']); assert.equal(ev.filter(e => e.t === 'tool_done').length, 2);
assert.equal(ev.filter(e => e.t === 'tools')[0].items[0].label, 'يتصفح الملفات');
const second = groqBodies.at(-1).messages; assert.deepEqual(second.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['c1', 'c2']);
assert.equal(ev.at(-1).reply, 'سأفحص. \n\nلا توجد ملفات.');
ok('parallel tool calls are answered per id and step texts are joined with a paragraph break');

// 3) provider fails mid-stream: partial text is reset and Workers AI answers instead
chatEnv.AI = { run: async () => ({ response: 'رد احتياطي' }) };
groqQueue.push(500);
res = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'اختبار' }) });
ev = await readEvents(res); await Promise.all(bg.splice(0));
assert.equal(ev.at(-1).reply, 'رد احتياطي'); delete chatEnv.AI;
ok('falls back to Workers AI when Groq fails');

// 4) the app closes mid-answer: the run still completes and the answer is saved for the next visit
groqQueue.push([delta('جزء أول '), delta('وجزء ثاني')]);
res = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'اكمل بدوني' }) });
const rd = res.body.getReader(); await rd.read(); await rd.cancel();
await Promise.all(bg.splice(0));
assert.equal(JSON.parse(store.get('run')).status, 'done'); assert.equal(JSON.parse(store.get('hist')).at(-1).text, 'جزء أول وجزء ثاني');
ok('closing the app mid-run does not stop the run');

// 5) a cut-off run is resumed by the cron tick from its last checkpoint, then the user is notified
{
  const stale = newRun('مهمة طويلة', 'مهمة طويلة'); await initRun(chatEnv, stale, [{ text: 'مهمة طويلة' }]);
  stale.contents.push({ role: 'model', parts: [{ functionCall: { name: 'list_files', args: {} }, cid: 'k1' }] }, { role: 'user', parts: [{ functionResponse: { name: 'list_files', response: { files: [] } }, cid: 'k1' }] });
  stale.step = 1; stale.acc = 'بدأت. '; stale.hb = Date.now() - 200000;
  store.set('run', JSON.stringify(stale));
  store.set('subs', JSON.stringify([]));
  groqQueue.push([delta('انتهيت.')]);
  await resumeStalledRun(chatEnv);
  const r = JSON.parse(store.get('run')); assert.equal(r.status, 'done'); assert.equal(r.resumed, 1); assert.equal(r.reply, 'بدأت. \n\nانتهيت.');
  assert.ok(groqBodies.at(-1).messages.some(m => m.role === 'tool' && m.tool_call_id === 'k1'));
  // a fresh heartbeat is left alone
  const live = { ...r, status: 'running', hb: Date.now() }; store.set('run', JSON.stringify(live)); await resumeStalledRun(chatEnv); assert.equal(JSON.parse(store.get('run')).status, 'running');
}
ok('cron resumes a stalled run from its checkpoint and leaves live runs alone');

// 6) one run at a time, cancel works
res = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'ثاني' }) }); assert.equal(res.status, 409); assert.equal((await res.json()).error, 'run_active');
res = await authed('/api/run/cancel', { method: 'POST' }); assert.equal(res.status, 200); assert.equal(JSON.parse(store.get('run')).status, 'cancelled');
const stopped = newRun('x', 'x'); await initRun(chatEnv, stopped, [{ text: 'x' }]); store.set('run', JSON.stringify({ ...stopped, status: 'cancelled' }));
assert.equal((await executeRun(chatEnv, stopped, { persist: true })).status, 'cancelled');
res = await authed('/api/state'); assert.equal((await res.json()).run, null);
ok('only one run at a time; cancel stops the run');

// 7) JSON mode and unconfigured provider
groqQueue.push([delta('رد عادي')]);
res = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'سلام', stream: false }) });
assert.equal((await res.json()).reply, 'رد عادي');
res = await mod.default.fetch(new Request('https://t.test/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + chatEnv.ACCESS_TOKEN }, body: '{"message":"a"}' }), { ACCESS_TOKEN: chatEnv.ACCESS_TOKEN, KV }, ctx);
assert.equal(res.status, 503);
ok('non-streaming JSON mode works; missing providers are reported');

// 8) completion pushes carry quiet/tag and a 24h TTL
{
  const pushes = []; const realFetch = globalThis.fetch;
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); const b64u = (u) => Buffer.from(u).toString('base64url');
  store.set('subs', JSON.stringify([{ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } }]));
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://fcm.googleapis.com')) { pushes.push(init.headers); return new Response(null, { status: 201 }); } return realFetch(url, init); };
  await mod.pushAll(chatEnv, 'اكتملت المهمة', '**تمّ** الأمر', { quiet: true, tag: 'run-1' });
  globalThis.fetch = realFetch;
  assert.equal(pushes.length, 1); assert.equal(pushes[0].TTL, '86400');
}
ok('push notifications are delivered with a 24h TTL');

// ---------- providers: Claude first, Groq model chain, keyless web search ----------
{
  const evs = (l) => l.map(e => ({ ...e }));
  const text = (i, t) => [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } }];
  const hooksSeen = []; const hooks = { onText: (d) => hooksSeen.push(d), onReset: () => hooksSeen.push('RESET') };
  const body = { systemInstruction: { parts: [{ text: 'sys' }] }, tools: [{ functionDeclarations: DECLS.slice(0, 2) }], contents: [
    { role: 'model', parts: [{ text: 'قديم' }] }, // a history that starts with the assistant must be trimmed
    { role: 'user', parts: [{ text: 'سلام' }] },
    { role: 'model', parts: [{ text: 'هلا' }, { functionCall: { name: 'list_reminders', args: {} }, cid: 't1' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'list_reminders', response: { reminders: [] } }, cid: 't1' }] }] };
  const am = anthropicMessages(body);
  assert.equal(am[0].role, 'user'); assert.deepEqual(am.map(m => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(am[1].content.map(b => b.type), ['text', 'tool_use']); assert.equal(am[2].content[0].tool_use_id, 't1');
  const aenv = { KV, ANTHROPIC_API_KEY: 'sk-ant-test', GROQ_API_KEY: 'g' };
  anthQueue.push([...text(0, 'أهلا '), ...text(0, 'بك'), { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'list_files' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'message_stop' }]);
  const res1 = await agentModel(aenv, body, hooks);
  assert.deepEqual(res1.candidates[0].content.parts.map(p => p.text || p.functionCall.name), ['أهلا بك', 'list_files']); assert.equal(res1.candidates[0].content.parts[1].cid, 'toolu_9');
  assert.equal(anthBodies.at(-1).model, 'claude-sonnet-5-5'); assert.equal(anthBodies.at(-1).stream, true); assert.equal(anthBodies.at(-1).system, 'sys'); assert.equal(anthBodies.at(-1).tools[0].input_schema.type, 'object');
  ok('Claude (Anthropic) is used first when ANTHROPIC_API_KEY is set, streams text and tool calls');
  // Claude fails -> Groq primary fails (429) -> second Groq model answers
  const before = groqBodies.length; anthQueue.push(529); groqQueue.push(429, [delta('من النموذج الثاني')]);
  const res2 = await agentModel(aenv, body, hooks);
  assert.equal(res2.candidates[0].content.parts[0].text, 'من النموذج الثاني');
  assert.deepEqual(groqBodies.slice(before).map(b => b.model), ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
  ok('a rate-limited provider falls through to the next Groq model before weaker providers');
  // keyless web search via DuckDuckGo
  const sr = await runTool({ KV }, 'search_web', { query: 'اختبار' });
  assert.deepEqual(sr.sources, ['https://example.com/a', 'https://example.org/b']); assert.match(sr.answer, /مثال & عنوان\nملخص النتيجة\nhttps:\/\/example.com\/a/);
  ok('search_web works without a Gemini key');
}

// ---------- name memory, summaries, clearer errors, retries ----------
{
  store.delete('profile'); store.delete('sum');
  assert.deepEqual(await runTool({ KV }, 'set_name', { name: 'محمد\nكبير' }), { ok: true, name: 'محمد كبير' });
  assert.equal(JSON.parse(store.get('profile')).name, 'محمد كبير'); assert.equal((await runTool({ KV }, 'set_name', { name: '  ' })).error, 'bad_arguments');
  assert.match(systemPrompt([], false, { name: 'محمد' }), /«محمد»/); assert.match(systemPrompt([], false, {}), /set_name/); assert.match(systemPrompt([], false, { summary: 'كان يسأل عن X' }), /كان يسأل عن X/);
  // profile survives clearing the chat and reaches the model prompt on the next turn
  let r2 = await authed('/api/history', { method: 'DELETE' }); assert.equal(r2.status, 200); assert.equal(JSON.parse(store.get('profile')).name, 'محمد كبير');
  groqQueue.push([delta('أهلا')]); const before = groqBodies.length;
  r2 = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'مرحبا' }) }); await readEvents(r2); await Promise.all(bg.splice(0));
  assert.match(groqBodies[before].messages[0].content, /«محمد كبير»/);
  assert.equal((await (await authed('/api/state')).json()).name, 'محمد كبير');
  ok('the name the user asks for is saved forever and sent to the model every turn');

  // long chats fold into a summary and keep the most recent turns
  const big = Array.from({ length: 44 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'رسالة ' + i, at: i }));
  store.set('hist', JSON.stringify(big)); groqQueue.push([delta('ملخص: المستخدم يسأل عن كذا')]);
  await maybeSummarize(chatEnv);
  assert.equal(JSON.parse(store.get('hist')).length, 20); assert.equal(JSON.parse(store.get('hist')).at(-1).text, 'رسالة 43'); assert.match(JSON.parse(store.get('sum')), /ملخص/);
  store.set('hist', JSON.stringify(big.slice(0, 10))); await maybeSummarize(chatEnv); assert.equal(JSON.parse(store.get('hist')).length, 10);
  ok('old conversation turns are summarised, recent ones kept, short chats untouched');

  // provider errors say which provider failed and why
  const e = Object.assign(new Error('groq_429'), { detail: ['groq_429', 'groq_429', 'gemini_403'] });
  assert.equal(errInfo(e).hint, 'Groq: وصل حدّه المؤقت · Gemini: المفتاح غير صالح أو غير مصرّح. جرّب بعد دقيقة.');
  ok('rate-limit errors name the provider and the reason');

  // a transient model failure is retried once; a transient tool failure too
  const rEnv = { ...chatEnv, RETRY_DELAY_MS: 1 };
  groqQueue.push(503, 503, [delta('نجح بعد إعادة')]); // chain of 2 groq models fails, retry round succeeds
  const rr = newRun('t', 't'); await initRun(rEnv, rr, [{ text: 't' }]); store.set('run', JSON.stringify(rr));
  const done = await executeRun(rEnv, rr, { persist: true }); assert.equal(done.status, 'done'); assert.equal(done.reply, 'نجح بعد إعادة');
  ok('a transient provider failure is retried automatically');
}

// ---------- leaving the app mid-task still ends with a push notification ----------
{
  const pushes = []; const realFetch = globalThis.fetch;
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); const b64u2 = (u) => Buffer.from(u).toString('base64url');
  store.set('subs', JSON.stringify([{ endpoint: 'https://fcm.googleapis.com/fcm/send/zzz', keys: { p256dh: b64u2(raw), auth: b64u2(crypto.getRandomValues(new Uint8Array(16))) } }]));
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://fcm.googleapis.com')) { pushes.push(url); return new Response(null, { status: 201 }); } return realFetch(url, init); };
  store.set('run', JSON.stringify({ status: 'done' }));
  groqQueue.push([delta('نتيجة المهمة الطويلة')]);
  const res9 = await authed('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'اشتغل وأنا طالع' }) });
  const rd9 = res9.body.getReader(); await rd9.read(); await rd9.cancel(); // the user closes the app
  await Promise.all(bg.splice(0)); globalThis.fetch = realFetch;
  assert.equal(JSON.parse(store.get('run')).status, 'done'); assert.equal(pushes.length, 1);
  assert.equal(JSON.parse(store.get('hist')).at(-1).text, 'نتيجة المهمة الطويلة');
  store.set('subs', JSON.stringify([]));
}
ok('closing the app mid-task: the work finishes and a completion push is sent');

console.log(`\nall ${n} checks passed`);

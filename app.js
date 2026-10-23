(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  let token = store.get('token');
  let attached = []; // {id,name}
  let busy = false;

  // ---------- api ----------
  async function api(path, opt = {}) {
    const headers = { Authorization: 'Bearer ' + token, ...(opt.headers || {}) };
    if (opt.json) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
    const r = await fetch(path, { method: opt.method || 'GET', headers, body: opt.body, cache: 'no-store' });
    let d = {}; try { d = await r.json(); } catch {}
    if (r.status === 401) { logout('الرمز غير صحيح'); throw new Error('unauthorized'); }
    if (!r.ok) throw Object.assign(new Error(d.hint || d.error || 'request_failed'), { data: d });
    return d;
  }

  const ERR = {
    ai_provider_not_configured: 'لم يُضبط أي مزوّد ذكاء اصطناعي في Cloudflare (GROQ_API_KEY أو AI أو GEMINI_API_KEY)',
    gemini_not_configured: 'لم يُضبط أي مزوّد ذكاء اصطناعي في Cloudflare',
    setup_required: 'الإعداد ناقص: ACCESS_TOKEN أو KV',
    rate_limited: 'محاولات كثيرة، انتظر قليلًا ثم جرّب',
    request_too_large: 'الطلب كبير جدًا',
    agent_failed: 'تعذّر على الوكيل إكمال الطلب، جرّب مرة ثانية',
    internal_error: 'خطأ داخلي في الخادم',
    empty_message: 'الرسالة فارغة',
    unauthorized: 'الرمز غير صحيح',
    request_failed: 'فشل الطلب',
  };
  const ltr = (x) => '\u2066' + x + '\u2069'; // isolate dates/URLs so they keep their order inside Arabic text
  const errText = (e) => ERR[e && e.message] || (e && e.message) || 'حدث خطأ غير متوقع';

  // ---------- UI helpers ----------
  function add(cls, text) {
    const d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = text;
    $('msgs').append(d); $('msgs').scrollTop = $('msgs').scrollHeight; return d;
  }
  function approvalCard(a) {
    const d = document.createElement('div'); d.className = 'appr';
    const t = document.createElement('div'); t.textContent = 'ينتظر موافقتك: ' + a.summary; d.append(t);
    const b = document.createElement('div'); b.className = 'btns';
    const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = 'نفّذ';
    const no = document.createElement('button'); no.textContent = 'ألغِ';
    const decide = async (decision) => {
      ok.disabled = no.disabled = true;
      try { const r = await api('/api/approve', { method: 'POST', json: { id: a.id, decision } }); d.remove(); add('sys', r.result); }
      catch (e) { t.textContent = 'انتهت صلاحية الطلب أو فشل: ' + errText(e); b.remove(); }
    };
    ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
    b.append(ok, no); d.append(b); $('msgs').append(d); $('msgs').scrollTop = $('msgs').scrollHeight;
  }
  function renderChips() {
    $('chips').textContent = '';
    for (const f of attached) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = f.name + ' ✕'; c.onclick = () => { attached = attached.filter(x => x !== f); renderChips(); }; $('chips').append(c); }
  }
  function speak(text) {
    const conv = $('optConv').checked;
    if ((!$('optVoiceOut').checked && !conv) || !('speechSynthesis' in window)) { if (conv) listenSoon(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/[*_`#\u{1F514}\u2705\u26A0\uFE0F]/gu, '').slice(0, 600));
      u.lang = 'ar'; u.onend = () => { if (conv) listenSoon(); }; u.onerror = u.onend; speechSynthesis.speak(u);
    } catch { if (conv) listenSoon(); }
  }
  function listenSoon() { setTimeout(() => { if ($('optConv').checked && !rec && !busy && !document.hidden && SR && !$('tab-chat').hidden) { try { startSR(); } catch {} } }, 500); }

  // ---------- chat ----------
  async function send(payload) {
    if (busy) return; busy = true; $('send').disabled = true;
    const typing = add('sys', 'يفكّر…');
    try {
      const d = await api('/api/chat', { method: 'POST', json: payload });
      typing.remove();
      if (d.transcript) add('me', d.transcript);
      add('bot', d.reply); speak(d.reply);
      for (const a of d.approvals || []) approvalCard(a);
    } catch (e) { typing.remove(); if (e.message !== 'unauthorized') add('sys', 'تنبيه: ' + errText(e)); }
    busy = false; $('send').disabled = false;
  }
  async function sendText(text) {
    text = text.trim(); if (!text && !attached.length) return;
    add('me', (attached.length ? attached.map(f => 'ملف: ' + f.name).join('\n') + '\n' : '') + text);
    const ids = attached.map(f => f.id); attached = []; renderChips();
    await send({ message: text, fileIds: ids });
  }
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; autosize(); sendText(t); });
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !/Android|iPhone/i.test(navigator.userAgent)) { e.preventDefault(); $('composer').requestSubmit(); } });
  const autosize = () => { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; };
  $('input').addEventListener('input', autosize);

  // ---------- files ----------
  $('attach').onclick = () => $('file').click();
  $('file').onchange = async () => {
    for (const f of $('file').files) {
      if (f.size > 20 * 1024 * 1024) { add('sys', `${f.name} أكبر من 20MB`); continue; }
      const note = add('sys', `جارٍ رفع ${f.name}…`);
      try {
        const d = await api('/api/files?name=' + encodeURIComponent(f.name), { method: 'PUT', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
        attached.push({ id: d.file.id, name: d.file.name }); note.textContent = `رُفع ${f.name}`;
      } catch (e) { note.textContent = `فشل رفع ${f.name}: ${errText(e)}`; }
    }
    $('file').value = ''; renderChips();
  };

  // ---------- voice ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, wav = null;
  function setRec(on) { $('mic').classList.toggle('rec', on); $('mic').setAttribute('aria-label', on ? 'إيقاف التسجيل' : 'تحدّث'); }
  function startSR() {
    rec = new SR(); rec.lang = $('optLang').value; rec.interimResults = true; rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; finalText = t; $('input').value = t; autosize(); };
    rec.onerror = (e) => { setRec(false); rec = null; if (e.error === 'not-allowed') $('optConv').checked = false; if (e.error === 'no-speech' || e.error === 'aborted') return; add('sys', e.error === 'not-allowed' ? 'اسمح للميكروفون من إعدادات المتصفح' : e.error === 'language-not-supported' ? 'اللغة غير مدعومة، غيّرها من الإعدادات' : 'تعذّر التعرف على الصوت: ' + e.error); };
    rec.onend = () => { setRec(false); rec = null; if (finalText && $('optAutoSend').checked) { $('input').value = ''; autosize(); sendText(finalText); } };
    rec.start(); setRec(true);
  }
  async function startWav() { // fallback when SpeechRecognition is unavailable: record 16kHz WAV and let Gemini transcribe
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)(); const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1); const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(ctx.destination);
    wav = { stop: () => { proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop()); const rate = ctx.sampleRate; ctx.close(); return encodeWav(chunks, rate); } };
    setRec(true);
  }
  function encodeWav(chunks, rate) {
    let len = 0; for (const c of chunks) len += c.length;
    const ratio = rate / 16000, n = Math.floor(len / ratio), pcm = new Int16Array(n);
    const all = new Float32Array(len); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf), w = (p, s) => [...s].forEach((c, i) => dv.setUint8(p + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(pcm); return new Uint8Array(buf);
  }
  function u8ToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  $('mic').onclick = async () => {
    try {
      if (rec) { rec.stop(); return; }
      if (wav) { const bytes = wav.stop(); wav = null; setRec(false); if (bytes.length > 1_000_000) { add('sys', 'التسجيل طويل، اختصره'); return; } add('sys', 'أرسلتُ التسجيل…'); await send({ audio: { mime: 'audio/wav', data: u8ToB64(bytes) }, fileIds: attached.map(f => f.id) }); attached = []; renderChips(); return; }
      speechSynthesis?.cancel?.();
      if (SR) startSR(); else await startWav();
    } catch (e) { setRec(false); add('sys', 'تعذّر تشغيل الميكروفون: ' + (e.message || e.name)); }
  };

  // ---------- tabs & lists ----------
  function tab(name) {
    for (const t of ['chat', 'files', 'tasks', 'settings']) $('tab-' + t).hidden = t !== name;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    if (name !== 'chat') refresh().catch((e) => { if (e.message !== 'unauthorized') add('sys', 'تعذّر تحديث البيانات: ' + errText(e)); });
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => tab(b.dataset.tab));
  function item(box, title, sub, onDel, extra) {
    const d = document.createElement('div'); d.className = 'item';
    const t = document.createElement('div'); t.textContent = title; if (sub) { const s = document.createElement('small'); s.textContent = sub; t.append(s); }
    d.append(t);
    const acts = document.createElement('div'); acts.className = 'acts';
    if (extra) acts.append(extra);
    if (onDel) { const b = document.createElement('button'); b.textContent = 'حذف'; b.className = 'danger'; b.onclick = async () => { if (!confirm('متأكد؟')) return; try { await onDel(); } catch (e) { if (e.message !== 'unauthorized') alert(errText(e)); } refresh().catch(() => {}); }; acts.append(b); }
    if (acts.children.length) d.append(acts);
    box.append(d);
  }
  function list(id, arr, fn, empty) { const box = $(id); box.textContent = ''; if (!arr.length) { box.textContent = empty; box.className = 'hint'; return; } box.className = ''; arr.forEach(x => fn(box, x)); }
  async function refresh(first) {
    const s = await api('/api/state');
    $('status').textContent = s.ready ? `جاهز · ${s.devices} جهاز إشعارات` : 'لم يُضبط مزوّد ذكاء اصطناعي';
    $('status').className = 'status ' + (s.ready ? 'ok' : 'bad');
    if (first) { $('msgs').textContent = ''; if (!s.hist.length) add('sys', 'أهلًا! اكتب أو اضغط الميكروفون وتكلّم. مثال: «ذكّرني بعد ساعة أشرب موية» أو ارفع مشروعك zip وقل «شن فيه؟»'); for (const h of s.hist) add(h.role === 'user' ? 'me' : 'bot' + (h.proactive ? ' pro' : ''), h.text); }
    list('fileList', s.files, (b, f) => { const dl = document.createElement('button'); dl.textContent = 'تنزيل'; dl.onclick = () => download(f); item(b, f.name, `${ltr(f.id)} · ${ltr((f.size / 1024).toFixed(1) + 'KB')}`, async () => api('/api/files?id=' + f.id, { method: 'DELETE' }), dl); }, 'ما فيه ملفات. استعمل زر الإرفاق في المحادثة.');
    list('jobList', s.jobs, (b, j) => item(b, (j.note ? j.note + ' — ' : '') + j.prompt, 'القادمة: ' + ltr(j.next) + (j.daily ? ' · يوميًا' : '') + (j.repeat ? ` · كل ${j.repeat} د` : ''), async () => api('/api/jobs?id=' + j.id, { method: 'DELETE' })), 'ما فيه مهام مجدولة. قل له مثلًا: «كل يوم الساعة 8 لخّص لي أخبار التقنية».');
    list('remList', s.reminders, (b, r) => item(b, r.text, ltr(r.when) + (r.repeat ? ` · يتكرر كل ${r.repeat} د` : ''), async () => api('/api/reminders?id=' + r.id, { method: 'DELETE' })), 'ما فيه تذكيرات.');
    list('watchList', s.watches, (b, w) => item(b, w.note || w.url, `${ltr(w.url)} · كل ${w.every} د`, async () => api('/api/watches?id=' + w.id, { method: 'DELETE' })), 'ما فيه مواقع مراقَبة.');
    list('memList', s.memory, (b, m) => item(b, m), 'ما فيه ذاكرة محفوظة.');
    $('info').textContent = `جسر الهاتف (Tasker): ${s.phoneBridge ? 'مفعّل' : 'غير مفعّل'}\nGitHub: ${s.github ? 'مربوط' : 'غير مربوط (GITHUB_TOKEN)'}\nأجهزة الإشعارات: ${s.devices}`;
    if (first) for (const p of s.pending) approvalCard(p);
  }

  async function download(f) {
    try {
      const r = await fetch('/api/file?id=' + f.id, { headers: { Authorization: 'Bearer ' + token } }); if (!r.ok) throw new Error('فشل التنزيل');
      const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { alert(errText(e)); }
  }

  // ---------- push ----------
  const urlB64 = (v) => { const p = (v + '='.repeat((4 - v.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(p), c => c.charCodeAt(0)); };
  $('enablePush').onclick = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('المتصفح لا يدعم الإشعارات. ثبّت التطبيق من قائمة Chrome ثم افتحه.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('رفضت إذن الإشعارات');
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api('/api/push/key');
      const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(publicKey) });
      await api('/api/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
      add('sys', 'تم تفعيل الإشعارات على هذا الجهاز'); refresh().catch(() => {}); alert('تم تفعيل الإشعارات');
    } catch (e) { alert('تعذّر: ' + errText(e)); }
  };
  $('testPush').onclick = async () => { try { const r = await api('/api/push/test', { method: 'POST' }); alert(`أُرسل: ${r.sent} · فشل: ${r.failed}`); } catch (e) { alert(errText(e)); } };
  $('clearChat').onclick = async () => { if (!confirm('تمسح المحادثة؟')) return; try { await api('/api/history', { method: 'DELETE' }); await refresh(true); tab('chat'); } catch (e) { if (e.message !== 'unauthorized') alert(errText(e)); } };
  for (const [id, key] of [['optVoiceOut', 'voiceOut'], ['optAutoSend', 'autoSend'], ['optConv', 'conv']]) { const el = $(id); const v = store.get(key); if (v !== '') el.checked = v === '1'; el.onchange = () => { store.set(key, el.checked ? '1' : '0'); if (id === 'optConv' && el.checked) { $('optAutoSend').checked = true; store.set('autoSend', '1'); tab('chat'); listenSoon(); } }; }
  $('optLang').value = store.get('lang', 'ar-LY'); $('optLang').onchange = () => store.set('lang', $('optLang').value);

  // ---------- login ----------
  function logout(msg) { token = ''; store.del('token'); $('app').hidden = true; $('login').hidden = false; $('loginMsg').textContent = msg || ''; }
  async function enter() { try { await refresh(true); $('login').hidden = true; $('app').hidden = false; } catch (e) { if (e.message !== 'unauthorized') { $('loginMsg').textContent = ERR[e.message] || 'تعذّر الاتصال بالخادم'; $('login').hidden = false; } } }
  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); token = $('token').value.trim(); if (!token) return; store.set('token', token); $('loginMsg').textContent = ''; enter(); });
  $('logout').onclick = () => logout('');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (token) { $('login').hidden = true; enter().then(() => { if ($('app').hidden) $('login').hidden = false; }); }
})();

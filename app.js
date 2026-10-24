(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const store = {
    get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let token = store.get('token');
  let attached = []; // {id,name}
  let busy = false, following = false, ctrl = null, userStopped = false, lastPayload = null, stick = true, hasPushNow = false;

  // ---------- small DOM helpers ----------
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const IC = {
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    retry: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/>',
    speak: '<path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  function icon(name) { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = IC[name]; return s; }
  function toast(text, ms = 2200) {
    const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
  }
  function confirmBox(text, okLabel = 'تأكيد', danger = false) {
    return new Promise((resolve) => {
      $('modalText').textContent = text; $('modalYes').textContent = okLabel; $('modalYes').className = danger ? 'danger' : 'primary';
      $('modal').hidden = false; $('modalYes').focus();
      const done = (v) => { $('modal').hidden = true; $('modalYes').onclick = $('modalNo').onclick = null; document.removeEventListener('keydown', onKey); $('modal').onclick = null; resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      $('modalYes').onclick = () => done(true); $('modalNo').onclick = () => done(false);
      $('modal').onclick = (e) => { if (e.target === $('modal')) done(false); };
    });
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {}
    const ta = el('textarea', 'sr-copy'); ta.value = t; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
  }
  function copyBtn(getText, label, cls) {
    const b = el('button', cls || 'act'); b.type = 'button'; b.append(icon('copy'), el('span', null, label));
    b.onclick = async () => {
      const ok = await copyText(getText()); const lab = b.lastChild;
      b.classList.toggle('ok', ok); b.replaceChild(icon(ok ? 'check' : 'copy'), b.firstChild); lab.textContent = ok ? 'تم النسخ' : 'تعذّر النسخ';
      setTimeout(() => { b.classList.remove('ok'); b.replaceChild(icon('copy'), b.firstChild); lab.textContent = label; }, 1700);
    };
    return b;
  }

  // ---------- theme ----------
  function applyTheme() {
    const t = store.get('theme', 'auto'), fs = store.get('fs', 'm'), d = document.documentElement;
    d.dataset.theme = t; d.dataset.fs = fs;
    const dark = t === 'dark' || (t === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#12100d' : '#f7f3ec';
  }

  // ---------- api ----------
  async function api(path, opt = {}) {
    const headers = { Authorization: 'Bearer ' + token, ...(opt.headers || {}) };
    if (opt.json) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
    const r = await fetch(path, { method: opt.method || 'GET', headers, body: opt.body, cache: 'no-store' });
    let d = {}; try { d = await r.json(); } catch {}
    if (r.status === 401) { logout('الرمز غير صحيح'); throw new Error('unauthorized'); }
    if (!r.ok) throw Object.assign(new Error(d.hint || d.error || 'request_failed'), { data: d, http: r.status });
    return d;
  }
  const ERR = {
    ai_provider_not_configured: 'لم يُضبط أي مزوّد ذكاء اصطناعي في Cloudflare (ANTHROPIC_API_KEY أو GROQ_API_KEY أو AI أو GEMINI_API_KEY)',
    gemini_not_configured: 'لم يُضبط أي مزوّد ذكاء اصطناعي في Cloudflare',
    setup_required: 'الإعداد ناقص: ACCESS_TOKEN أو KV',
    rate_limited: 'محاولات كثيرة، انتظر قليلًا ثم جرّب',
    request_too_large: 'الطلب كبير جدًا',
    agent_failed: 'تعذّر على الوكيل إكمال الطلب، جرّب مرة ثانية',
    internal_error: 'خطأ داخلي في الخادم',
    empty_message: 'الرسالة فارغة',
    unauthorized: 'الرمز غير صحيح',
    request_failed: 'فشل الطلب',
    run_active: 'الوكيل لسه يشتغل على طلب سابق',
    run_stalled: 'توقفت المهمة ولم تكتمل',
    audio_invalid: 'تعذّر قبول التسجيل الصوتي',
    file_too_large: 'الملف أكبر من الحد المسموح',
  };
  const ltr = (x) => '⁦' + x + '⁩'; // isolate dates/URLs so they keep their order inside Arabic text
  const errText = (e) => { const m = e && (e.message || e.error || e); return ERR[m] || (/^(anthropic|groq|gemini|workers_ai)_/.test(m) ? 'مزوّد الذكاء الاصطناعي رجّع خطأ (' + m + ')، جرّب بعد قليل' : m) || 'حدث خطأ غير متوقع'; };

  // ---------- markdown -> DOM (model output never reaches innerHTML) ----------
  function renderInline(parent, nodes) {
    for (const n of nodes) {
      switch (n.t) {
        case 'text': parent.append(document.createTextNode(n.v)); break;
        case 'b': { const e = el('strong'); renderInline(e, n.c); parent.append(e); break; }
        case 'i': { const e = el('em'); renderInline(e, n.c); parent.append(e); break; }
        case 'del': { const e = el('del'); renderInline(e, n.c); parent.append(e); break; }
        case 'code': parent.append(el('code', 'ic', n.v)); break;
        case 'br': parent.append(el('br')); break;
        case 'a': {
          const href = MD.safeHref(n.href);
          if (!href) { renderInline(parent, n.c); break; }
          const a = el('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; renderInline(a, n.c); parent.append(a); break;
        }
      }
    }
  }
  function codeBlock(b) {
    const w = el('div', 'code'); w.dir = 'ltr';
    const head = el('div', 'code-head'); head.append(el('span', null, b.lang || 'code'), copyBtn(() => b.text, 'نسخ'));
    const pre = el('pre'), code = el('code');
    for (const t of MD.highlight(b.text, b.lang)) { if (t.c) code.append(el('span', 'tk-' + t.c, t.v)); else code.append(document.createTextNode(t.v)); }
    pre.append(code); w.append(head, pre); return w;
  }
  function renderList(b) {
    const l = el(b.type); if (b.type === 'ol' && b.start > 1) l.start = b.start;
    for (const it of b.items) { const li = el('li'); li.dir = 'auto'; renderInline(li, it.inline); for (const c of it.children) li.append(renderList(c)); l.append(li); }
    return l;
  }
  function renderBlock(b) {
    switch (b.type) {
      case 'p': { const e = el('p'); e.dir = 'auto'; renderInline(e, b.inline); return e; }
      case 'h': { const e = el(b.level <= 1 ? 'h2' : b.level === 2 ? 'h3' : 'h4'); e.dir = 'auto'; renderInline(e, b.inline); return e; }
      case 'code': return codeBlock(b);
      case 'ul': case 'ol': return renderList(b);
      case 'quote': { const q = el('blockquote'); for (const c of b.blocks) q.append(renderBlock(c)); return q; }
      case 'hr': return el('hr');
      case 'table': {
        const w = el('div', 'tbl'), t = el('table'), th = el('thead'), tb = el('tbody'), hr = el('tr');
        const cls = (i) => b.align[i] ? 'al-' + b.align[i] : '';
        b.head.forEach((h, i) => { const c = el('th', cls(i)); c.dir = 'auto'; renderInline(c, h); hr.append(c); });
        th.append(hr);
        for (const r of b.rows) { const tr = el('tr'); r.forEach((cell, i) => { const c = el('td', cls(i)); c.dir = 'auto'; renderInline(c, cell); tr.append(c); }); tb.append(tr); }
        t.append(th, tb); w.append(t); return w;
      }
    }
    return el('div');
  }
  // Re-render only the blocks whose source changed, so earlier blocks keep their DOM (selection, scroll, copy buttons).
  function mdRender(container, text, cache) {
    const blocks = MD.parse(text);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], c = cache[i];
      if (c && c.raw === b.raw && c.type === b.type) continue;
      const node = renderBlock(b);
      if (c) c.node.replaceWith(node); else container.append(node);
      cache[i] = { raw: b.raw, type: b.type, node };
    }
    while (cache.length > blocks.length) cache.pop().node.remove();
  }

  // ---------- scrolling ----------
  function scrollEnd(force) { const m = $('msgs'); if (force || stick) { m.scrollTop = m.scrollHeight; } }
  $('msgs').addEventListener('scroll', () => { const m = $('msgs'); stick = m.scrollHeight - m.scrollTop - m.clientHeight < 90; $('toBottom').hidden = stick; }, { passive: true });
  $('toBottom').onclick = () => { stick = true; $('msgs').scrollTo({ top: $('msgs').scrollHeight, behavior: 'smooth' }); };

  // ---------- chat messages ----------
  function clearWelcome() { const w = document.getElementById('welcomeBox'); if (w) w.remove(); }
  function addUser(text, files) {
    clearWelcome();
    const d = el('div', 'm me'); const b = el('div', 'bubble'); b.dir = 'auto'; b.textContent = (files && files.length ? files.map(f => '📎 ' + f.name).join('\n') + (text ? '\n' : '') : '') + text;
    const acts = el('div', 'acts'); acts.append(copyBtn(() => text, 'نسخ'));
    d.append(b, acts); $('msgs').append(d); scrollEnd(true); return d;
  }
  function addSys(text, cls) { clearWelcome(); const d = el('div', 'm sys' + (cls ? ' ' + cls : ''), text); $('msgs').append(d); scrollEnd(); return d; }

  class Bot {
    constructor(opts = {}) {
      this.root = el('div', 'm bot' + (opts.pro ? ' pro' : ''));
      this.steps = el('div', 'steps'); this.body = el('div', 'md');
      this.root.append(this.steps, this.body);
      this.target = ''; this.shown = 0; this.cache = []; this.raf = 0; this.done = false; this.live = false; this.chips = new Map(); this.dots = null; this.running = 0;
    }
    mount() { clearWelcome(); $('msgs').append(this.root); return this; }
    wait(label) {
      this.live = true; this.root.classList.add('live');
      if (!this.dots) { this.dots = el('div', 'dots'); this.dots.append(el('b'), el('b'), el('b')); this.label = el('span', 'dots-label'); this.dots.append(this.label); this.root.append(this.dots); }
      this.label.textContent = label || ''; this.updateDots(); return this;
    }
    updateDots() { if (this.dots) this.dots.hidden = this.done || this.running > 0 || this.shown < this.target.length || (this.shown > 0 && !this.label.textContent && false); }
    push(d) { this.target += d; this.kick(); }
    reset(text) { this.target = text; this.shown = text.length; this.cache = []; this.body.textContent = ''; this.paint(); }
    tools(items) {
      for (const it of items) { const c = el('span', 'step'); c.append(el('i'), document.createTextNode(it.label)); this.steps.append(c); this.chips.set(it.id, c); this.running++; }
      if (this.label) this.label.textContent = ''; this.updateDots(); scrollEnd();
    }
    toolDone(id, ok) { const c = this.chips.get(id); if (c) { c.classList.add(ok ? 'done' : 'fail'); this.running = Math.max(0, this.running - 1); } this.updateDots(); }
    kick() { if (!this.raf) this.raf = requestAnimationFrame(() => this.tick()); }
    tick() {
      this.raf = 0;
      const remain = this.target.length - this.shown;
      if (remain > 0) {
        const step = this.done ? Math.max(8, Math.ceil(remain / 6)) : Math.max(2, Math.ceil(remain / 10));
        this.shown = Math.min(this.target.length, this.shown + step);
        const c = this.target.charCodeAt(this.shown - 1); if (c >= 0xD800 && c <= 0xDBFF && this.shown < this.target.length) this.shown++;
        this.paint();
      }
      if (this.shown < this.target.length) this.kick(); else if (this.done) this.settle();
      this.updateDots();
    }
    paint() {
      let t = this.target.slice(0, this.shown);
      if (this.shown < this.target.length) { // hide a table that is still arriving (raw pipes flicker until the header separator row exists)
        const m = /(?:^|\n)((?:[ \t]*\|[^\n]*\n?)+)$/.exec(t);
        if (m && !/^[ \t]*\|[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/m.test(m[1])) t = t.slice(0, m.index);
      }
      mdRender(this.body, t, this.cache); scrollEnd();
    }
    finish(text) {
      if (typeof text === 'string' && text) this.target = text;
      this.done = true; this.running = 0; this.kick(); if (this.shown >= this.target.length) this.settle();
    }
    settle() {
      if (this.settled) return; this.settled = true;
      this.root.classList.remove('live'); if (this.dots) this.dots.hidden = true;
      this.steps.querySelectorAll('.step:not(.done):not(.fail)').forEach(c => c.classList.add('done'));
      if (!this.target.trim()) { this.root.remove(); return; }
      const acts = el('div', 'acts'); acts.append(copyBtn(() => this.target, 'نسخ'));
      if ('speechSynthesis' in window) { const s = el('button', 'act'); s.type = 'button'; s.append(icon('speak'), el('span', null, 'استماع')); s.onclick = () => speak(this.target, true); acts.append(s); }
      this.root.append(acts);
    }
    final(text) { this.target = text; this.shown = text.length; this.done = true; this.paint(); this.settle(); return this; }
    fail(msg) {
      this.finish(); this.root.classList.remove('live'); if (this.dots) this.dots.hidden = true;
      const e = el('div', 'm sys err', msg); const r = el('button', 'act'); r.type = 'button'; r.append(icon('retry'), el('span', null, 'إعادة المحاولة'));
      r.onclick = () => { e.remove(); this.root.remove(); if (lastPayload) send(lastPayload); };
      this.root.append(e, r);
    }
    stopped() { this.finish(); this.root.classList.remove('live'); if (this.dots) this.dots.hidden = true; this.root.append(el('div', 'm sys', 'تم الإيقاف')); }
  }

  function approvalCard(a) {
    clearWelcome();
    const d = el('div', 'appr'); d.append(el('b', null, 'ينتظر موافقتك'));
    const t = el('div', null, a.summary); t.dir = 'auto'; d.append(t);
    const b = el('div', 'btns'); const ok = el('button', 'primary', 'نفّذ'), no = el('button', null, 'ألغِ');
    const decide = async (decision) => {
      ok.disabled = no.disabled = true;
      try { const r = await api('/api/approve', { method: 'POST', json: { id: a.id, decision } }); d.remove(); addSys(r.result); }
      catch (e) { t.textContent = 'انتهت صلاحية الطلب أو فشل: ' + errText(e); b.remove(); }
    };
    ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
    b.append(ok, no); d.append(b); $('msgs').append(d); scrollEnd();
  }

  const SUGGESTIONS = [
    ['لخّص لي أخبار التقنية اليوم', 'لخّص لي أخبار التقنية اليوم'],
    ['ذكّرني بعد ساعة أشرب موية', 'ذكّرني بعد ساعة أشرب موية'],
    ['راجع كود مشروعي على GitHub وقلّي شنو المشاكل', 'راجع كود مشروعي على GitHub وقلّي شنو المشاكل'],
    ['اكتب لي خطة مذاكرة لأسبوع', 'اكتب لي خطة مذاكرة لأسبوع'],
  ];
  function showWelcome() {
    const w = el('div', 'welcome'); w.id = 'welcomeBox';
    const mark = el('div', 'mark'); mark.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4 41 14v20L24 44 7 34V14z"/><circle cx="24" cy="24" r="6"/></svg>';
    w.append(mark, el('h1', null, 'كيف أقدر أساعدك؟'), el('p', null, 'اكتب أو تكلّم. أنفّذ المهام بنفسي وأكمل حتى لو قفلت التطبيق، وأرسلك إشعار لما أخلّص.'));
    const g = el('div', 'sugs');
    for (const [label, text] of SUGGESTIONS) { const b = el('button', 'sug', label); b.type = 'button'; b.onclick = () => sendText(text); g.append(b); }
    w.append(g); $('msgs').append(w);
  }

  // ---------- speech out ----------
  function speak(text, force) {
    const conv = $('optConv').checked;
    if ((!force && !$('optVoiceOut').checked && !conv) || !('speechSynthesis' in window)) { if (conv) listenSoon(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance((MD.plain(text) || text).slice(0, 700));
      u.lang = 'ar'; u.onend = () => { if (conv) listenSoon(); }; u.onerror = u.onend; speechSynthesis.speak(u);
    } catch { if (conv) listenSoon(); }
  }
  function listenSoon() { setTimeout(() => { if ($('optConv').checked && !rec && !busy && !document.hidden && SR && !$('tab-chat').hidden) { try { startSR(); } catch {} } }, 500); }

  // ---------- busy state / status ----------
  function setBusy(on) {
    busy = on; $('send').hidden = on; $('stop').hidden = !on;
    const s = $('status'); if (on) { s.textContent = 'يعمل…'; s.className = 'status work'; } else if (s.classList.contains('work')) { s.textContent = ''; s.className = 'status'; refresh().catch(() => {}); }
    syncSend();
  }
  function syncSend() { $('send').disabled = busy || !($('input').value.trim() || attached.length); }
  let bannerKind = '';
  function showBanner(kind, text, btn, onBtn) {
    bannerKind = kind; $('bannerText').textContent = text; const b = $('bannerBtn'); b.hidden = !btn; if (btn) { b.textContent = btn; b.onclick = onBtn; } $('banner').hidden = false;
  }
  function hideBanner(kind) { if (!kind || bannerKind === kind) { $('banner').hidden = true; bannerKind = ''; } }
  $('bannerClose').onclick = () => { if (bannerKind === 'push') store.set('pushNudge', String(Date.now())); hideBanner(); };
  function pushNudge(devices) {
    if (following || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    hasPushNow = devices > 0 && Notification.permission === 'granted';
    if (hasPushNow) { hideBanner('push'); return; }
    if (Notification.permission === 'denied' || Date.now() - Number(store.get('pushNudge', '0')) < 3 * 864e5) return;
    showBanner('push', 'فعّل الإشعارات ليوصلك تنبيه لما يخلّص الوكيل مهمة وأنت خارج التطبيق.', 'تفعيل', () => enablePush());
  }

  // ---------- chat transport (server-sent events) ----------
  async function streamChat(payload, onEvent, signal, beat) {
    const r = await fetch('/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal, cache: 'no-store' });
    if (r.status === 401) { logout('الرمز غير صحيح'); throw new Error('unauthorized'); }
    if (!r.ok || !r.body) { let d = {}; try { d = await r.json(); } catch {} throw Object.assign(new Error(d.hint || d.error || 'request_failed'), { data: d, http: r.status }); }
    const reader = r.body.getReader(), td = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      beat(); buf += td.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) if (line.startsWith('data:')) { let ev = null; try { ev = JSON.parse(line.slice(5)); } catch {} if (ev) onEvent(ev); }
      }
    }
  }
  async function send(payload) {
    if (busy) return;
    setBusy(true); lastPayload = payload; stick = true; userStopped = false;
    const bot = new Bot().mount().wait('يفكّر…'); scrollEnd(true);
    ctrl = new AbortController();
    let finished = false, lastBeat = Date.now(), err = null;
    const watchdog = setInterval(() => { if (Date.now() - lastBeat > 40000) ctrl.abort(); }, 5000);
    const onEvent = (ev) => {
      switch (ev.t) {
        case 'transcript': addSys('🎤 ' + ev.d); break;
        case 'text': bot.push(ev.d); break;
        case 'reset': bot.reset(ev.text || ''); break;
        case 'tools': bot.tools(ev.items); break;
        case 'tool_done': bot.toolDone(ev.id, ev.ok); break;
        case 'approval': approvalCard(ev.a); break;
        case 'detached': break;
        case 'done': finished = true; bot.finish(ev.reply); speak(ev.reply); break;
        case 'cancelled': finished = true; bot.finish(ev.reply || ''); break;
        case 'error': finished = true; bot.fail(errText(Object.assign(new Error(ev.hint || ev.error), {}))); break;
      }
    };
    try { await streamChat(payload, onEvent, ctrl.signal, () => { lastBeat = Date.now(); }); } catch (e) { err = e; }
    clearInterval(watchdog);
    if (finished) { setBusy(false); return; }
    if (err && err.message === 'unauthorized') { bot.root.remove(); setBusy(false); return; }
    if (userStopped) { bot.stopped(); setBusy(false); return; }
    if (err && err.http === 409) { bot.root.remove(); addSys('الوكيل لسه يشتغل على طلب سابق. استنى لين يخلص أو اضغط إيقاف.'); followRun(); return; }
    if (err && err.http) { bot.fail(errText(err)); setBusy(false); return; }
    // The connection dropped (app backgrounded, network lost). The server keeps working; follow it.
    bot.wait('انقطع الاتصال، الوكيل يكمل في الخلفية…');
    followRun();
  }
  // Poll the server until the background run finishes, then rebuild the chat from the saved history.
  async function followRun() {
    if (following) return;
    following = true; setBusy(true);
    showBanner('bg', 'الوكيل يكمل مهمتك في الخلفية. تقدر تقفل التطبيق وبيجيك إشعار لما يخلّص.');
    let last = null, fails = 0;
    for (let n = 0; n < 720; n++) {
      await sleep(n < 3 ? 1500 : 3000);
      try { last = (await api('/api/run')).run; fails = 0; if (!last || last.status !== 'running') break; }
      catch (e) { if (e.message === 'unauthorized') { following = false; setBusy(false); return; } if (++fails > 40) break; }
    }
    following = false; hideBanner('bg');
    await refresh(true).catch(() => {});
    setBusy(false);
    if (last && last.status === 'error') addSys('تعذّر إكمال المهمة: ' + errText(Object.assign(new Error(last.hint || last.error), {})), 'err');
    else if (last && last.status === 'done') toast('اكتملت المهمة');
    pushNudge(hasPushNow ? 1 : 0);
  }
  async function sendText(text) {
    text = text.trim(); if ((!text && !attached.length) || busy) return;
    const files = attached; attached = []; renderChips(); syncSend();
    addUser(text, files);
    await send({ message: text, fileIds: files.map(f => f.id) });
  }
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; autosize(); sendText(t); });
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !/Android|iPhone|iPad/i.test(navigator.userAgent)) { e.preventDefault(); $('composer').requestSubmit(); } });
  const autosize = () => { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 140) + 'px'; };
  $('input').addEventListener('input', () => { autosize(); syncSend(); });
  $('stop').onclick = async () => {
    userStopped = true; try { ctrl && ctrl.abort(); } catch {}
    try { await api('/api/run/cancel', { method: 'POST' }); } catch {}
  };

  // ---------- files ----------
  function renderChips() {
    $('chips').textContent = '';
    for (const f of attached) { const c = el('span', 'chip'); c.append(el('span', null, f.name), icon('x')); c.onclick = () => { attached = attached.filter(x => x !== f); renderChips(); syncSend(); }; $('chips').append(c); }
  }
  $('attach').onclick = () => $('file').click();
  $('uploadBtn').onclick = () => $('file').click();
  $('file').onchange = async () => {
    for (const f of $('file').files) {
      if (f.size > 20 * 1024 * 1024) { toast(`${f.name} أكبر من 20MB`); continue; }
      toast(`جارٍ رفع ${f.name}…`, 8000);
      try {
        const d = await api('/api/files?name=' + encodeURIComponent(f.name), { method: 'PUT', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
        attached.push({ id: d.file.id, name: d.file.name }); toast(`رُفع ${f.name}`);
      } catch (e) { toast(`فشل رفع ${f.name}: ${errText(e)}`, 4000); }
    }
    $('file').value = ''; renderChips(); syncSend();
    if (!$('tab-files').hidden) refresh().catch(() => {});
  };

  // ---------- voice in ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, wav = null;
  function setRec(on) { $('mic').classList.toggle('rec', on); $('mic').setAttribute('aria-label', on ? 'إيقاف التسجيل' : 'تحدّث'); }
  function startSR() {
    rec = new SR(); rec.lang = $('optLang').value; rec.interimResults = true; rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; finalText = t; $('input').value = t; autosize(); syncSend(); };
    rec.onerror = (e) => { setRec(false); rec = null; if (e.error === 'not-allowed') $('optConv').checked = false; if (e.error === 'no-speech' || e.error === 'aborted') return; addSys(e.error === 'not-allowed' ? 'اسمح للميكروفون من إعدادات المتصفح' : e.error === 'language-not-supported' ? 'اللغة غير مدعومة، غيّرها من الإعدادات' : 'تعذّر التعرف على الصوت: ' + e.error, 'err'); };
    rec.onend = () => { setRec(false); rec = null; if (finalText && $('optAutoSend').checked) { $('input').value = ''; autosize(); sendText(finalText); } };
    rec.start(); setRec(true);
  }
  async function startWav() { // fallback when SpeechRecognition is unavailable: record 16kHz WAV and let the server transcribe
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
      if (wav) { const bytes = wav.stop(); wav = null; setRec(false); if (bytes.length > 1_000_000) { addSys('التسجيل طويل، اختصره', 'err'); return; } const ids = attached.map(f => f.id); attached = []; renderChips(); await send({ audio: { mime: 'audio/wav', data: u8ToB64(bytes), lang: $('optLang').value }, fileIds: ids }); return; }
      speechSynthesis?.cancel?.();
      if (SR && !$('optWhisper').checked) startSR(); else await startWav();
    } catch (e) { setRec(false); addSys('تعذّر تشغيل الميكروفون: ' + (e.message || e.name), 'err'); }
  };

  // ---------- tabs & lists ----------
  function tab(name) {
    for (const t of ['chat', 'files', 'tasks', 'settings']) $('tab-' + t).hidden = t !== name;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'chat') { scrollEnd(true); } else refresh().catch((e) => { if (e.message !== 'unauthorized') toast('تعذّر تحديث البيانات: ' + errText(e)); });
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => tab(b.dataset.tab));
  function item(box, title, sub, onDel, extra, lead) {
    const d = el('div', 'item');
    const t = el('div'); t.dir = 'auto';
    if (lead) { const f = el('div', 'fi'); f.append(lead); const n = el('div', 'nm'); n.dir = 'auto'; n.textContent = title; if (sub) n.append(el('small', null, sub)); f.append(n); t.append(f); }
    else { t.append(document.createTextNode(title)); if (sub) t.append(el('small', null, sub)); }
    d.append(t);
    const acts = el('div', 'acts');
    if (extra) acts.append(extra);
    if (onDel) { const b = el('button', 'danger', 'حذف'); b.onclick = async () => { if (!(await confirmBox('متأكد من الحذف؟', 'حذف', true))) return; try { await onDel(); } catch (e) { if (e.message !== 'unauthorized') toast(errText(e)); } refresh().catch(() => {}); }; acts.append(b); }
    if (acts.children.length) d.append(acts);
    box.append(d);
  }
  function list(id, arr, fn, empty) { const box = $(id); box.textContent = ''; if (!arr.length) { box.append(el('div', 'empty', empty)); return; } arr.forEach(x => fn(box, x)); }
  function renderHistory(hist) {
    $('msgs').textContent = '';
    if (!hist.length) { showWelcome(); return; }
    for (const h of hist) { if (h.role === 'user') addUser(h.text); else new Bot({ pro: h.proactive }).mount().final(h.text); }
    scrollEnd(true);
  }
  async function refresh(first) {
    const s = await api('/api/state');
    if (!busy || first) { const st = $('status'); if (!st.classList.contains('work')) { st.textContent = s.ready ? `جاهز · ${s.devices} جهاز إشعارات` : 'لم يُضبط مزوّد ذكاء اصطناعي'; st.className = 'status ' + (s.ready ? 'ok' : 'bad'); } }
    if (first) {
      renderHistory(s.hist);
      for (const p of s.pending) approvalCard(p);
      if (s.run && !following) { addUser(s.run.prompt); new Bot().mount().wait('الوكيل يعمل على طلبك…'); stick = true; scrollEnd(true); followRun(); }
    }
    list('fileList', s.files, (b, f) => {
      const dl = el('button', null, 'تنزيل'); dl.onclick = () => download(f);
      const ext = el('div', 'ext', (f.name.split('.').pop() || 'file').slice(0, 4));
      item(b, f.name, `${ltr((f.size / 1024).toFixed(1) + 'KB')} · ${ltr(f.id)}`, async () => api('/api/files?id=' + f.id, { method: 'DELETE' }), dl, ext);
    }, 'ما فيه ملفات. استعمل زر الإرفاق في المحادثة أو «رفع ملف».');
    list('jobList', s.jobs, (b, j) => item(b, (j.note ? j.note + ' — ' : '') + j.prompt, 'القادمة: ' + ltr(j.next) + (j.daily ? ' · يوميًا' : '') + (j.repeat ? ` · كل ${j.repeat} د` : ''), async () => api('/api/jobs?id=' + j.id, { method: 'DELETE' })), 'ما فيه مهام مجدولة. قل له مثلًا: «كل يوم الساعة 8 لخّص لي أخبار التقنية».');
    list('remList', s.reminders, (b, r) => item(b, r.text, ltr(r.when) + (r.repeat ? ` · يتكرر كل ${r.repeat} د` : ''), async () => api('/api/reminders?id=' + r.id, { method: 'DELETE' })), 'ما فيه تذكيرات.');
    list('watchList', s.watches, (b, w) => item(b, w.note || w.url, `${ltr(w.url)} · كل ${w.every} د`, async () => api('/api/watches?id=' + w.id, { method: 'DELETE' })), 'ما فيه مواقع مراقَبة.');
    list('memList', s.memory, (b, m) => item(b, m), 'ما فيه ذاكرة محفوظة.');
    $('info').textContent = `الاسم المحفوظ: ${s.name || 'لم يُحفظ بعد'}\nجسر الهاتف (Tasker): ${s.phoneBridge ? 'مفعّل' : 'غير مفعّل'}\nGitHub: ${s.github ? 'مربوط' : 'غير مربوط (GITHUB_TOKEN)'}\nأجهزة الإشعارات: ${s.devices}`;
    pushNudge(s.devices);
  }
  async function download(f) {
    try {
      const r = await fetch('/api/file?id=' + f.id, { headers: { Authorization: 'Bearer ' + token } }); if (!r.ok) throw new Error('فشل التنزيل');
      const url = URL.createObjectURL(await r.blob()); const a = el('a'); a.href = url; a.download = f.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { toast(errText(e)); }
  }

  // ---------- push ----------
  const urlB64 = (v) => { const p = (v + '='.repeat((4 - v.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(p), c => c.charCodeAt(0)); };
  async function enablePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('المتصفح لا يدعم الإشعارات. ثبّت التطبيق من قائمة Chrome ثم افتحه.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('رفضت إذن الإشعارات');
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api('/api/push/key');
      const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(publicKey) });
      await api('/api/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
      hideBanner('push'); hasPushNow = true; toast('تم تفعيل الإشعارات على هذا الجهاز'); refresh().catch(() => {});
    } catch (e) { toast('تعذّر: ' + errText(e), 4200); }
  }
  $('enablePush').onclick = enablePush;
  $('testPush').onclick = async () => { try { const r = await api('/api/push/test', { method: 'POST' }); toast(`أُرسل: ${r.sent} · فشل: ${r.failed}`); } catch (e) { toast(errText(e)); } };
  async function newChat() {
    if (busy) { toast('انتظر لين يخلص الوكيل أو أوقفه'); return; }
    if (!(await confirmBox('تمسح المحادثة وتبدأ من جديد؟', 'مسح', true))) return;
    try { await api('/api/history', { method: 'DELETE' }); await refresh(true); tab('chat'); } catch (e) { if (e.message !== 'unauthorized') toast(errText(e)); }
  }
  $('clearChat').onclick = newChat; $('newChat').onclick = newChat;

  // ---------- settings ----------
  for (const [id, key] of [['optWhisper', 'whisper'], ['optVoiceOut', 'voiceOut'], ['optAutoSend', 'autoSend'], ['optConv', 'conv']]) {
    const e = $(id); const v = store.get(key); if (v !== '') e.checked = v === '1';
    e.onchange = () => { store.set(key, e.checked ? '1' : '0'); if (id === 'optConv' && e.checked) { $('optAutoSend').checked = true; store.set('autoSend', '1'); tab('chat'); listenSoon(); } };
  }
  $('optLang').value = store.get('lang', 'ar-LY'); $('optLang').onchange = () => store.set('lang', $('optLang').value);
  $('optTheme').value = store.get('theme', 'auto'); $('optTheme').onchange = () => { store.set('theme', $('optTheme').value); applyTheme(); };
  $('optFont').value = store.get('fs', 'm'); $('optFont').onchange = () => { store.set('fs', $('optFont').value); applyTheme(); };
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);

  // ---------- login ----------
  function logout(msg) { token = ''; store.del('token'); $('app').hidden = true; $('login').hidden = false; $('loginMsg').textContent = msg || ''; }
  async function enter() { try { await refresh(true); $('login').hidden = true; $('app').hidden = false; scrollEnd(true); } catch (e) { if (e.message !== 'unauthorized') { $('loginMsg').textContent = ERR[e.message] || 'تعذّر الاتصال بالخادم'; $('login').hidden = false; } } }
  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); token = $('token').value.trim(); if (!token) return; store.set('token', token); $('loginMsg').textContent = ''; enter(); });
  $('showToken').onclick = () => { const t = $('token'); t.type = t.type === 'password' ? 'text' : 'password'; };
  $('logout').onclick = () => logout('');

  applyTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'push' && !following && !busy) refresh(true).catch(() => {}); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token && !busy && !following && !$('app').hidden) refresh().catch(() => {}); });
  if (token) { $('login').hidden = true; enter().then(() => { if ($('app').hidden) $('login').hidden = false; }); }
})();

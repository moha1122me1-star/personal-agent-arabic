// Small, dependency-free Markdown parser + code highlighter for chat replies.
// It only produces plain data (blocks / inline nodes). The UI turns these into DOM nodes with textContent,
// so model output can never inject HTML. Exposed as globalThis.MD.
(function (root) {
  'use strict';
  const WORD = /[\p{L}\p{N}]/u;
  const safeHref = (h) => (/^(https?:\/\/|mailto:)/i.test(String(h || '').trim()) ? String(h).trim() : '');

  // ---------- inline ----------
  function inline(s) {
    const out = []; let buf = ''; let i = 0; const n = s.length;
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
    const pair = (mark, kind, ch) => { // emphasis / strike: returns true when consumed
      const next = s[i + mark.length] || '', prev = i > 0 ? s[i - 1] : '';
      if (!next || /\s/.test(next)) return false;
      if (ch === '_' && prev && WORD.test(prev)) return false;
      let j = i + mark.length;
      while ((j = s.indexOf(mark, j)) >= 0) {
        const before = s[j - 1], after = s[j + mark.length] || '';
        const single = mark.length === 1;
        if (before && !/\s/.test(before) && !(single && (before === ch || after === ch)) && !(ch === '_' && after && WORD.test(after))) {
          flush(); out.push({ t: kind, c: inline(s.slice(i + mark.length, j)) }); i = j + mark.length; return true;
        }
        j += mark.length;
      }
      return false;
    };
    while (i < n) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!|~>]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (ch === '`') {
        let k = i; while (s[k] === '`') k++;
        const len = k - i; let j = k, found = -1;
        while ((j = s.indexOf('`', j)) >= 0) { let e = j; while (s[e] === '`') e++; if (e - j === len) { found = j; break; } j = e; }
        if (found > 0) { flush(); out.push({ t: 'code', v: s.slice(k, found).replace(/^ (.+) $/s, '$1') }); i = found + len; continue; }
        buf += s.slice(i, k); i = k; continue;
      }
      if (ch === '*' || ch === '_') {
        const mark = s[i + 1] === ch ? ch + ch : ch;
        if (pair(mark, mark.length === 2 ? 'b' : 'i', ch)) continue;
        buf += mark; i += mark.length; continue;
      }
      if (ch === '~' && s[i + 1] === '~') { if (pair('~~', 'del', '~')) continue; buf += '~~'; i += 2; continue; }
      if (ch === '[') {
        const close = s.indexOf(']', i + 1);
        if (close > 0 && s[close + 1] === '(') {
          const end = s.indexOf(')', close + 2);
          if (end > 0) { const href = s.slice(close + 2, end).trim().split(/\s+/)[0]; flush(); out.push({ t: 'a', href, c: inline(s.slice(i + 1, close)) }); i = end + 1; continue; }
        }
      }
      if (ch === 'h' && (i === 0 || !WORD.test(s[i - 1])) && /^https?:\/\//.test(s.slice(i, i + 8))) {
        const m = /^https?:\/\/[^\s<>"'`]+/.exec(s.slice(i));
        if (m) {
          let url = m[0]; while (/[.,;:!?)\]}،؛]$/.test(url) && !(url.endsWith(')') && url.includes('('))) url = url.slice(0, -1);
          flush(); out.push({ t: 'a', href: url, c: [{ t: 'text', v: url }] }); i += url.length; continue;
        }
      }
      if (ch === '\n') { flush(); out.push({ t: 'br' }); i++; continue; }
      buf += ch; i++;
    }
    flush(); return out;
  }

  // ---------- blocks ----------
  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  const FENCE_END = /^\s{0,3}(`{3,}|~{3,})\s*$/;
  const HEAD = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const indentOf = (s) => s.replace(/\t/g, '    ').length;
  const splitRow = (line) => { let t = line.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1); return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')); };
  const startsTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && SEP.test(lines[i + 1]) && (lines[i + 1].includes('|') || splitRow(lines[i]).length > 1);
  const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEAD.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || startsTable(lines, i);

  function parseList(rows) {
    const mk = (marker) => /\d/.test(marker) ? { type: 'ol', start: parseInt(marker, 10) || 1, items: [] } : { type: 'ul', items: [] };
    const first = ITEM.exec(rows[0]);
    const root = mk(first[2]); const stack = [{ indent: indentOf(first[1]), list: root }];
    for (const line of rows) {
      const m = ITEM.exec(line);
      if (m) {
        const ind = indentOf(m[1]);
        while (stack.length > 1 && ind < stack[stack.length - 1].indent) stack.pop();
        let top = stack[stack.length - 1];
        if (ind > top.indent + 1) {
          const parent = top.list.items[top.list.items.length - 1];
          if (parent) { const nl = mk(m[2]); parent.children.push(nl); stack.push({ indent: ind, list: nl }); top = stack[stack.length - 1]; }
        }
        top.list.items.push({ lines: [m[3]], children: [] });
      } else if (line.trim()) {
        const it = stack[stack.length - 1].list.items.at(-1); if (it) it.lines.push(line.trim());
      }
    }
    const fin = (l) => ({ ...l, items: l.items.map(it => ({ inline: inline(it.lines.join('\n')), children: it.children.map(fin) })) });
    return fin(root);
  }

  function blocks(lines) {
    const out = []; let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m = FENCE.exec(line);
      if (m) {
        const body = []; let j = i + 1, closed = false;
        for (; j < lines.length; j++) { const c = FENCE_END.exec(lines[j]); if (c && c[1][0] === m[1][0] && c[1].length >= m[1].length) { closed = true; break; } body.push(lines[j]); }
        out.push({ type: 'code', lang: (m[2] || '').toLowerCase(), text: body.join('\n'), open: !closed, raw: lines.slice(i, closed ? j + 1 : j).join('\n') });
        i = closed ? j + 1 : j; continue;
      }
      if ((m = HEAD.exec(line))) { out.push({ type: 'h', level: m[1].length, inline: inline(m[2]), raw: line }); i++; continue; }
      if (HR.test(line)) { out.push({ type: 'hr', raw: line }); i++; continue; }
      if (QUOTE.test(line)) {
        const q = []; let j = i;
        while (j < lines.length && QUOTE.test(lines[j])) { q.push(lines[j].replace(/^\s{0,3}>\s?/, '')); j++; }
        out.push({ type: 'quote', blocks: blocks(q), raw: lines.slice(i, j).join('\n') }); i = j; continue;
      }
      if (startsTable(lines, i)) {
        const head = splitRow(line), align = splitRow(lines[i + 1]).map(c => (/^:-*:$/.test(c) ? 'c' : /-:$/.test(c) ? 'r' : /^:-/.test(c) ? 'l' : ''));
        const rows = []; let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].includes('|')) { rows.push(splitRow(lines[j])); j++; }
        out.push({ type: 'table', head: head.map(inline), align, rows: rows.map(r => head.map((_, k) => inline(r[k] ?? ''))), raw: lines.slice(i, j).join('\n') }); i = j; continue;
      }
      if (ITEM.test(line)) {
        const rows = []; let j = i; const b0 = ITEM.exec(line), baseInd = indentOf(b0[1]), baseOrd = /\d/.test(b0[2]);
        while (j < lines.length) {
          const l = lines[j], im = ITEM.exec(l);
          if (im && !HR.test(l)) { if (indentOf(im[1]) <= baseInd + 1 && /\d/.test(im[2]) !== baseOrd) break; rows.push(l); j++; continue; }
          if (!l.trim()) { let k = j + 1; while (k < lines.length && !lines[k].trim()) k++; if (k < lines.length && (ITEM.test(lines[k]) || /^\s{2,}\S/.test(lines[k])) && !HR.test(lines[k])) { j = k; continue; } break; }
          if (/^\s+\S/.test(l) && !FENCE.test(l)) { rows.push(l); j++; continue; }
          break;
        }
        out.push({ ...parseList(rows), raw: lines.slice(i, j).join('\n') }); i = j; continue;
      }
      const para = [line]; let j = i + 1;
      while (j < lines.length && lines[j].trim() && !startsBlock(lines, j)) { para.push(lines[j]); j++; }
      out.push({ type: 'p', inline: inline(para.join('\n').trim()), raw: para.join('\n') }); i = j;
    }
    return out;
  }
  const parse = (src) => blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));

  // ---------- plain text (for read-aloud / notifications) ----------
  const plain = (src) => String(src ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_~|]+/g, '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- syntax highlighting ----------
  const KW = new Set(('const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof of in null undefined true false this super yield static void delete ' +
    'def elif not and or is None True False as with except raise lambda pass global nonlocal self print ' +
    'interface type enum implements public private protected readonly abstract final int long double float bool boolean string char byte struct fn let mut pub use mod impl trait match loop where unsafe package func go defer chan range select namespace using override virtual ' +
    'then fi done esac echo cd export local ' +
    'select insert into values update set create table drop alter join left right inner outer on group by order limit having distinct union primary key foreign references index').split(' '));
  const FAMILY = { js: 'c', javascript: 'c', jsx: 'c', ts: 'c', typescript: 'c', tsx: 'c', mjs: 'c', node: 'c', java: 'c', c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', go: 'c', rust: 'c', rs: 'c', kotlin: 'c', swift: 'c', php: 'c', dart: 'c', css: 'c', scss: 'c', json: 'j', jsonc: 'c',
    py: 'h', python: 'h', bash: 'h', sh: 'h', shell: 'h', zsh: 'h', yaml: 'h', yml: 'h', toml: 'h', ruby: 'h', rb: 'h', dockerfile: 'h', ini: 'h', sql: 's', html: 'x', xml: 'x', svg: 'x', vue: 'x' };
  const RX = {
    c: /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)|(\b0x[\da-f]+\b|\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/gi,
    j: /()("(?:\\.|[^"\\\n])*"?)|(-?\b\d[\d.]*(?:e[+-]?\d+)?\b)|([A-Za-z_]+)|([\s\S])/gi,
    h: /(#[^\n]*)|("(?:\\.|[^"\\\n])*"?|'[^'\n]*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w-]*)|([\s\S])/gi,
    s: /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:''|[^'])*'?|"[^"\n]*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)|([\s\S])/gi,
    x: /(<!--[\s\S]*?(?:-->|$))|("[^"\n]*"?|'[^'\n]*'?)|(\b\d+(?:\.\d+)?\b)|(<\/?[A-Za-z][\w:-]*|\/?>)|([\s\S])/gi,
  };
  function highlight(code, lang) {
    const fam = FAMILY[String(lang || '').toLowerCase()];
    if (!fam || code.length > 12000) return [{ c: '', v: code }];
    const re = new RegExp(RX[fam].source, 'gi'); const toks = []; let m;
    const push = (c, v) => { const last = toks[toks.length - 1]; if (last && last.c === c) last.v += v; else toks.push({ c, v }); };
    while ((m = re.exec(code))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m[1]) push('c', m[1]);
      else if (m[2]) push('s', m[2]);
      else if (m[3]) push('n', m[3]);
      else if (m[4]) {
        const w = m[4];
        if (fam === 'x') push('k', w);
        else if (fam === 'j') push(/^(true|false|null)$/.test(w) ? 'k' : '', w);
        else if (KW.has(fam === 's' ? w.toLowerCase() : w)) push('k', w);
        else if (code[re.lastIndex] === '(' && fam !== 'h') push('f', w);
        else if (/^[A-Z][A-Za-z0-9]+$/.test(w) && fam === 'c') push('t', w);
        else push('', w);
      } else push('', m[5]);
    }
    return toks;
  }

  root.MD = { parse, inline, plain, highlight, safeHref };
})(globalThis);

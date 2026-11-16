/* My iPhone — SillyTavern extension (v0.1.0) */
(() => {
'use strict';

const MOD = 'my_iphone';
const FEE = 0.001, SPREAD = 0.0005, LOAN_MAX = 500000, APR = 0.03;
const TICK_MS = 1000, TPC = 6;               // 1 tick / second, 6 ticks per candle
const TAG_ALL = /\[\[PHONE:[\s\S]*?\]\]/g;
const TAG_ONE = /\[\[PHONE:(\{[\s\S]*?\})\]\]/g;
const LEN = {
  short:  { label: '简短', tok: 150, rule: 'Reply with one short sentence.' },
  medium: { label: '适中', tok: 400, rule: 'Reply with 1-3 sentences.' },
  long:   { label: '详细', tok: 900, rule: 'Reply with up to two short paragraphs.' },
};

/* ---------- helpers ---------- */
const X = () => SillyTavern.getContext();
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round(n * 100) / 100;
const fmt = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgn = n => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uid = () => Math.random().toString(36).slice(2, 9);
const hhmm = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const dt = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

/* ---------- storage (per character card) ---------- */
function M() {
  const s = X().extensionSettings;
  s[MOD] ??= {};
  const m = s[MOD];
  m.global ??= {};
  m.global.api ??= { url: '', key: '', model: '' };
  m.global.replyLen ??= 'medium';
  m.global.inject ??= true;
  m.global.fab ??= null;
  m.cards ??= {};
  return m;
}
const G = () => M().global;
const save = () => X().saveSettingsDebounced();
function cardKey() {
  const c = X();
  if (c.groupId) return 'group_' + c.groupId;
  const ch = c.characters?.[c.characterId];
  return ch?.avatar ? 'char_' + ch.avatar : 'none';
}
const newCard = () => ({
  balance: 2000, ledger: [],
  loan: { principal: 0, accrued: 0, t: Date.now() },
  fx: { cash: 0, shares: 0, avg: 0, price: 100, candles: [], cur: null, n: 0, regime: null, t: Date.now(), log: [] },
  contacts: [], chats: {}, unread: {},
});
function D() {
  const m = M(), k = cardKey();
  m.cards[k] ??= newCard();
  return m.cards[k];
}

/* ---------- toast ---------- */
let toastT;
function toast(msg) {
  let el = $('#mip-toast');
  if (!el) { el = document.createElement('div'); el.id = 'mip-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600);
}

/* ---------- wallet / bank logic ---------- */
function addTx(amt, memo, src) {
  const d = D(); amt = r2(amt);
  if (!amt) return false;
  if (d.balance + amt < -1e-9) { toast('余额不足：' + memo); return false; }
  d.balance = r2(d.balance + amt);
  d.ledger.unshift({ id: uid(), t: Date.now(), amt, memo, src: src || null });
  if (d.ledger.length > 100) d.ledger.length = 100;
  save(); refreshPrompt(); return true;
}
function undoSrc(src) {
  const d = D();
  const gone = d.ledger.filter(e => e.src === src);
  if (!gone.length) return;
  gone.forEach(e => { d.balance = r2(d.balance - e.amt); });
  d.ledger = d.ledger.filter(e => e.src !== src);
}
function accrue() {
  const L = D().loan, now = Date.now();
  if (L.principal > 0) L.accrued = r2(L.accrued + L.principal * APR * ((now - L.t) / 864e5) / 365);
  L.t = now;
}
const totalDebt = () => { accrue(); const L = D().loan; return r2(L.principal + L.accrued); };

/* ---------- FX simulation ---------- */
function newRegime() {
  const k = Math.random(), len = r => Math.floor(r + Math.random() * r);
  if (k < 0.28) return { drift: 0.0004, vol: 0.0020, left: len(120) };
  if (k < 0.56) return { drift: -0.0005, vol: 0.0022, left: len(100) };
  if (k < 0.88) return { drift: 0, vol: 0.0014, left: len(150) };
  return { drift: (Math.random() - 0.5) * 0.003, vol: 0.005, left: len(50) };
}
function tickPrice(F, p) {
  if (!F.regime || --F.regime.left <= 0) F.regime = newRegime();
  let ret = F.regime.drift + F.regime.vol * gauss() - 0.0003 * Math.log(p / 100);
  if (Math.random() < 0.0008) ret += (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.07);
  return Math.max(1, Math.round(p * (1 + ret) * 100) / 100);
}
function stepCandle(F) {
  const o = F.price; let p = o, h = o, l = o;
  for (let i = 0; i < TPC; i++) { p = tickPrice(F, p); if (p > h) h = p; if (p < l) l = p; }
  F.price = p; F.candles.push([o, h, l, p]);
  if (F.candles.length > 240) F.candles.shift();
}
function ensureFx() {
  const F = D().fx, now = Date.now();
  if (!F.candles.length) { F.price = 100; F.regime = null; for (let i = 0; i < 120; i++) stepCandle(F); }
  else {
    const n = Math.min(300, Math.floor((now - F.t) / (TICK_MS * TPC)));
    if (n > 0) { for (let i = 0; i < n; i++) stepCandle(F); F.cur = null; F.n = 0; }
  }
  F.t = now; return F;
}
const ask = F => F.price * (1 + SPREAD);
const bid = F => F.price * (1 - SPREAD);
const fxValue = d => r2(d.fx.shares * bid(d.fx) * (1 - FEE));
let fxTimer = null;
function liveTick() {
  const F = D().fx;
  F.price = tickPrice(F, F.price);
  const c = F.cur ??= [F.price, F.price, F.price, F.price];
  c[3] = F.price; if (F.price > c[1]) c[1] = F.price; if (F.price < c[2]) c[2] = F.price;
  if (++F.n >= TPC) { F.candles.push(c); if (F.candles.length > 240) F.candles.shift(); F.cur = null; F.n = 0; }
  F.t = Date.now();
  paintFx();
}
function paintFx() {
  const F = D().fx, cv = $('#fxcv');
  const pe = $('#fxp');
  if (pe) {
    const base = F.candles[0]?.[0] || F.price, ch = (F.price - base) / base * 100;
    pe.textContent = fmt(F.price);
    const ce = $('#fxc'); ce.textContent = (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch).toFixed(2) + '%'; ce.className = 'fx-chg ' + (ch >= 0 ? 'up' : 'dn');
    const me = $('#fxm');
    if (me) me.innerHTML = F.shares ? `持有 <b>${F.shares}</b> 股 · 成本 ${fmt(F.avg)} · 浮动 <b class="${plCls(unreal(F))}">${sgn(unreal(F))}</b>` : '当前未持仓';
  }
  const pb = $('#fxport'); if (pb) pb.innerHTML = portHtml();
  if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const arr = F.candles.slice(-60); if (F.cur) arr.push(F.cur);
  let lo = Math.min(...arr.map(c => c[2])), hi = Math.max(...arr.map(c => c[1]));
  if (F.shares > 0) { lo = Math.min(lo, F.avg); hi = Math.max(hi, F.avg); }
  const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad;
  const cw = (W - 46) / 60, Y = v => H - 6 - (v - lo) / (hi - lo) * (H - 12);
  g.font = '10px -apple-system, sans-serif'; g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4, y = Y(v);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(0, y); g.lineTo(W - 44, y); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(v.toFixed(2), W - 42, y);
  }
  arr.forEach((c, i) => {
    const x = i * cw + cw / 2, up = c[3] >= c[0];
    g.strokeStyle = g.fillStyle = up ? '#30d158' : '#ff453a';
    g.beginPath(); g.moveTo(x, Y(c[1])); g.lineTo(x, Y(c[2])); g.stroke();
    const y1 = Y(Math.max(c[0], c[3])), y2 = Y(Math.min(c[0], c[3]));
    g.fillRect(x - cw * 0.35, y1, cw * 0.7, Math.max(1, y2 - y1));
  });
  const line = (v, col, label) => {
    const y = Y(v); g.setLineDash([4, 4]); g.strokeStyle = col; g.beginPath(); g.moveTo(0, y); g.lineTo(W - 44, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.fillRect(W - 44, y - 8, 44, 16); g.fillStyle = '#fff'; g.fillText(label, W - 41, y);
  };
  line(F.price, '#0a84ff', F.price.toFixed(2));
  if (F.shares > 0) line(F.avg, '#ff9f0a', F.avg.toFixed(2));
}
const unreal = F => r2(F.shares * bid(F) * (1 - FEE) - F.shares * F.avg);
const plCls = n => (n >= 0 ? 'up' : 'dn');
function portHtml() {
  const d = D(), F = d.fx, mv = fxValue(d), un = unreal(F);
  const realized = r2(F.log.filter(x => x.pl != null).reduce((a, x) => a + x.pl, 0));
  return `<div class="mip-group">
    <div class="mip-row"><span>FX 账户现金</span><b>${fmt(F.cash)}</b></div>
    <div class="mip-row"><span>持仓</span><b>${F.shares} 股</b></div>
    <div class="mip-row"><span>持仓均价（含手续费）</span><b>${F.shares ? fmt(F.avg) : '—'}</b></div>
    <div class="mip-row"><span>持仓市值（扣费后）</span><b>${fmt(mv)}</b></div>
    <div class="mip-row"><span>浮动盈亏</span><b class="${plCls(un)}">${F.shares ? sgn(un) : '—'}</b></div>
    <div class="mip-row"><span>已实现盈亏</span><b class="${plCls(realized)}">${sgn(realized)}</b></div></div>
    <p class="mip-foot">资金请在「银行」App 转入。每笔交易含 0.1% 手续费与 0.05% 买卖价差。</p>`;
}
function tradeSheet(side) {
  const F = D().fx, buy = side === 'buy';
  const maxQ = () => buy ? Math.floor(F.cash / (ask(F) * (1 + FEE))) : F.shares;
  modal({
    title: (buy ? '买入 ' : '卖出 ') + 'AURA',
    html: `<div class="mip-sh-m">${buy ? '可用资金 ' + fmt(F.cash) : '可卖 ' + F.shares + ' 股'} · 最多 <b id="trmax">${maxQ()}</b> 股</div>
      <input class="mip-in" id="trq" type="text" inputmode="numeric" placeholder="数量（股）" value="1">
      <div class="mip-quick"><button data-q=".25">25%</button><button data-q=".5">50%</button><button data-q="1">全部</button></div>
      <div class="mip-sh-m" id="trest"></div>`,
    ok: buy ? '确认买入' : '确认卖出',
    onMount(el) {
      const inp = el.querySelector('#trq'), est = el.querySelector('#trest');
      const upd = () => {
        const q = parseInt(inp.value) || 0, px = buy ? ask(F) : bid(F), amt = px * q, fee = amt * FEE;
        el.querySelector('#trmax').textContent = maxQ();
        est.textContent = q > 0 ? `参考成交价 ${fmt(px)} · 手续费 ${fmt(fee)} · ${buy ? '预计支出' : '预计到账'} ${fmt(buy ? amt + fee : amt - fee)}` : '';
      };
      inp.addEventListener('input', upd);
      el.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { inp.value = Math.floor(maxQ() * parseFloat(b.dataset.q)); upd(); }));
      upd();
    },
    onOk(el) {
      const q = parseInt(el.querySelector('#trq').value) || 0;
      if (q <= 0) { toast('请输入数量'); return false; }
      if (q > maxQ()) { toast(buy ? '资金不足' : '持仓不足'); return false; }
      const px = buy ? ask(F) : bid(F), amt = px * q, fee = amt * FEE;
      if (buy) {
        F.avg = (F.avg * F.shares + amt + fee) / (F.shares + q);
        F.shares += q; F.cash = r2(F.cash - amt - fee);
        F.log.unshift({ t: Date.now(), side: 'BUY', q, px: r2(px), fee: r2(fee), pl: null });
      } else {
        const net = amt - fee, pl = r2(net - F.avg * q), pct = F.avg ? pl / (F.avg * q) * 100 : 0;
        F.cash = r2(F.cash + net); F.shares -= q;
        F.log.unshift({ t: Date.now(), side: 'SELL', q, px: r2(px), fee: r2(fee), pl, pct: r2(pct) });
        if (!F.shares) F.avg = 0;
      }
      if (F.log.length > 200) F.log.length = 200;
      save(); toast((buy ? '已买入 ' : '已卖出 ') + q + ' 股'); renderKeep(); return true;
    },
  });
}

/* ---------- AI ---------- */
async function ai(messages, max = 300) {
  const a = G().api;
  if (!a.url || !a.key || !a.model) throw new Error('请先在「设置」里配置 AI 渠道');
  let u = a.url.trim().replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(u)) u += '/chat/completions';
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.key.trim() },
    body: JSON.stringify({ model: a.model.trim(), messages, max_tokens: max, temperature: 0.9, stream: false }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100));
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/* ---------- prompt injection (hidden, goes to the AI only) ---------- */
function refreshPrompt() {
  const c = X();
  if (!G().inject) { c.setExtensionPrompt(MOD, '', 1, 1); return; }
  const u = c.name1 || 'User', d = D();
  const txt = `[Phone & wallet system note — hidden, never mention or quote it in the story.
- ${u}'s current cash: ${fmt(d.balance)} USD. Only ${u} knows this. Other characters do NOT know how much money ${u} has unless ${u} tells them or it is plainly visible.
- ${u} cannot spend more than they have. If ${u} can't afford something, they can't buy it — write the scene accordingly.
- If money really changes hands in your reply, add ONE line at the very end: [[PHONE:{"money":[{"amt":-25.5,"memo":"dinner"}]}]] (negative = ${u} spends, positive = ${u} earns, USD).
- Only if ${u} and a character have BOTH clearly agreed to exchange contact info in your reply, also include "contacts":["Name"] in that line. If a saved contact texts ${u}, include "sms":[{"from":"Name","text":"..."}].
- If none of this applies, add nothing.]`;
  c.setExtensionPrompt(MOD, txt, 1, 1, false, 0);
}

/* ---------- parsing story messages ---------- */
function parseTags(text) {
  const out = []; let m; TAG_ONE.lastIndex = 0;
  while ((m = TAG_ONE.exec(text || ''))) { try { out.push(JSON.parse(m[1])); } catch { /* ignore */ } }
  return out;
}
function applyMessage(i) {
  const c = X(), msg = c.chat?.[i];
  if (!msg || msg.is_user) return;
  const src = c.chatId + ':' + i;
  undoSrc(src);
  for (const p of parseTags(msg.mes)) {
    (p.money || []).forEach(x => { const a = Number(x.amt); if (isFinite(a)) addTx(a, String(x.memo || '剧情消费').slice(0, 40), src); });
    (p.contacts || []).forEach(n => addContact(String(n)));
    (p.sms || []).forEach(s => receiveSms(String(s.from || ''), String(s.text || ''), src));
  }
  save();
}
function stripDom() {
  document.querySelectorAll('#chat .mes_text').forEach(el => {
    if (el.innerHTML.includes('[[PHONE:')) el.innerHTML = el.innerHTML.replace(TAG_ALL, '');
  });
}

/* ---------- contacts ---------- */
const findContact = id => D().contacts.find(c => c.id === id);
function addContact(name) {
  name = name.trim();
  if (!name || name === X().name1) return false;
  const d = D();
  if (d.contacts.some(c => c.name.toLowerCase() === name.toLowerCase())) return false;
  d.contacts.push({ id: uid(), name, avatar: '', t: Date.now() });
  save(); toast('已添加联系人：' + name); renderKeep(); return true;
}
function receiveSms(from, text, src) {
  const d = D(), c = d.contacts.find(x => x.name.toLowerCase() === from.trim().toLowerCase());
  if (!c || !text) return;
  const h = d.chats[c.id] ??= [];
  if (h.some(m => m.src === src && m.text === text)) return;
  h.push({ r: 'them', text, t: Date.now(), src });
  if (!(S.open && S.app === 'chat' && S.p.id === c.id)) d.unread[c.id] = (d.unread[c.id] || 0) + 1;
  toast(`短信 · ${c.name}：${text.slice(0, 30)}`); save(); renderKeep();
}
async function refreshContacts() {
  const c = X(), last = (c.chat || []).slice(-3);
  let n = 0;
  last.forEach(m => parseTags(m.mes).forEach(p => (p.contacts || []).forEach(x => { if (addContact(String(x))) n++; })));
  const a = G().api;
  if (a.url && a.key && a.model && last.length) {
    try {
      const body = last.map(m => `${m.name}: ${(m.mes || '').replace(TAG_ALL, '').slice(0, 600)}`).join('\n');
      const out = await ai([
        { role: 'system', content: `You read roleplay text. Decide whether ${c.name1} and a character BOTH explicitly agreed to exchange contact info (phone number, messaging account, etc.). If only one side agreed, or it is unclear, return an empty list. Reply with JSON only: {"contacts":["Character Name"]}` },
        { role: 'user', content: body }], 150);
      const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      (j.contacts || []).forEach(x => { if (addContact(String(x))) n++; });
    } catch (e) { toast('AI 检查失败：' + e.message.slice(0, 60)); return; }
  }
  if (!n) toast('没有发现新的联系人');
}
function hue(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function avatar(c, cls = '') {
  const ch = X().characters?.find(x => x.name === c.name);
  const url = c.avatar || (ch?.avatar ? '/thumbnail?type=avatar&file=' + encodeURIComponent(ch.avatar) : '');
  return `<div class="mip-av ${cls}" style="background:hsl(${hue(c.name)} 55% 52%)"><span>${esc([...c.name][0] || '?')}</span>${url ? `<img src="${esc(url)}" onerror="this.remove()">` : ''}</div>`;
}
function pickAvatar(id) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files?.[0]; if (!f) return;
    const img = new Image(); img.onload = () => {
      const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
      const m = Math.min(img.width, img.height); cv.getContext('2d').drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s);
      const c = findContact(id); if (c) { c.avatar = cv.toDataURL('image/jpeg', 0.8); save(); renderKeep(); }
    };
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}
function buildMessages(c, h) {
  const cx = X(), ch = cx.characters?.find(x => x.name === c.name);
  const sub = s => (s || '').replace(/\{\{char\}\}/gi, c.name).replace(/\{\{user\}\}/gi, cx.name1);
  const story = (cx.chat || []).slice(-2).map(m => `${m.name}: ${(m.mes || '').replace(TAG_ALL, '').slice(0, 400)}`).join('\n');
  const sys = `You are ${c.name}, texting ${cx.name1} in a phone messaging app. Stay fully in character.
${ch ? 'Character info:\n' + sub(ch.description).slice(0, 1500) + '\n' + sub(ch.personality).slice(0, 500) : ''}
Recent story context (reference only):\n${story}
Rules: reply ONLY as a text message, in the language the conversation uses. No narration, no asterisks. ${LEN[G().replyLen].rule}`;
  return [{ role: 'system', content: sys }, ...h.slice(-14).map(m => ({ role: m.r === 'me' ? 'user' : 'assistant', content: m.text }))];
}
async function sendChat() {
  const inp = $('#cin'); if (!inp || S.busy) return;
  const text = inp.value.trim(); if (!text) return;
  const id = S.p.id, c = findContact(id), d = D(), h = d.chats[id] ??= [];
  inp.value = ''; h.push({ r: 'me', text, t: Date.now() });
  S.busy = true; paintMsgs(true); save();
  try {
    const reply = (await ai(buildMessages(c, h), LEN[G().replyLen].tok)).replace(/^["“]|["”]$/g, '');
    h.push({ r: 'them', text: reply || '…', t: Date.now() });
  } catch (e) { toast('AI 错误：' + e.message.slice(0, 80)); }
  S.busy = false; save(); if (S.open && S.app === 'chat') paintMsgs();
}
function paintMsgs(typing) {
  const el = $('#msgs'); if (!el) return;
  const h = D().chats[S.p.id] || [];
  el.innerHTML = h.map(m => `<div class="b ${m.r}">${esc(m.text)}</div>`).join('') + (typing ? '<div class="b them typ"><i></i><i></i><i></i></div>' : '');
  el.scrollTop = el.scrollHeight;
}

/* ---------- icons ---------- */
const ICONS = {
  wallet: `<svg viewBox="0 0 60 60"><rect width="60" height="60" fill="#111"/><rect x="9" y="14" width="42" height="9" rx="4" fill="#ff9f0a"/><rect x="9" y="20" width="42" height="9" rx="4" fill="#ffd60a"/><rect x="9" y="26" width="42" height="9" rx="4" fill="#30d158"/><rect x="9" y="32" width="42" height="9" rx="4" fill="#0a84ff"/><path d="M9 38h42v10a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5z" fill="#2c2c2e"/><rect x="38" y="41" width="9" height="6" rx="2" fill="#fff"/></svg>`,
  appstore: `<svg viewBox="0 0 60 60"><defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2bc4ff"/><stop offset="1" stop-color="#0a6cff"/></linearGradient></defs><rect width="60" height="60" fill="url(#gA)"/><g stroke="#fff" stroke-width="4.4" stroke-linecap="round" fill="none"><path d="M30 14L19 42M30 14L41 42M22.5 33H37.5M16 44.5h10"/></g></svg>`,
  contacts: `<svg viewBox="0 0 60 60"><rect width="60" height="60" fill="#e5e5ea"/><circle cx="29" cy="24" r="9" fill="#8e8e93"/><path d="M11 50c2-11 10-15 18-15s16 4 18 15z" fill="#8e8e93"/><g><rect x="54" y="8" width="6" height="8" fill="#ff9f0a"/><rect x="54" y="18" width="6" height="8" fill="#30d158"/><rect x="54" y="28" width="6" height="8" fill="#0a84ff"/><rect x="54" y="38" width="6" height="8" fill="#ff453a"/></g></svg>`,
  fx: `<svg viewBox="0 0 60 60"><rect width="60" height="60" fill="#000"/><path d="M15 0V60M30 0V60M45 0V60M0 15H60M0 30H60M0 45H60" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M5 51L16 40L24 45L35 28L42 34L55 11" fill="none" stroke="#30d158" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="55" cy="11" r="3" fill="#30d158"/></svg>`,
  bank: `<svg viewBox="0 0 60 60"><defs><linearGradient id="gB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4cd964"/><stop offset="1" stop-color="#14a44d"/></linearGradient></defs><rect width="60" height="60" fill="url(#gB)"/><path d="M30 11L50 22H10z" fill="#fff"/><g fill="#fff"><rect x="14" y="26" width="5" height="16" rx="1.5"/><rect x="23" y="26" width="5" height="16" rx="1.5"/><rect x="32" y="26" width="5" height="16" rx="1.5"/><rect x="41" y="26" width="5" height="16" rx="1.5"/><rect x="10" y="45" width="40" height="5" rx="2"/></g></svg>`,
  settings: `<svg viewBox="0 0 60 60"><defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8b8be"/><stop offset="1" stop-color="#6e6e75"/></linearGradient></defs><rect width="60" height="60" fill="url(#gS)"/><g fill="#2c2c2e" transform="translate(30 30)"><circle r="14"/>${[0, 45, 90, 135].map(a => `<rect x="-4" y="-20" width="8" height="40" rx="2" transform="rotate(${a})"/>`).join('')}</g><circle cx="30" cy="30" r="6" fill="#9a9aa0"/></svg>`,
};
const APPS = [['wallet', '钱包'], ['appstore', 'App Store'], ['contacts', '联系人'], ['fx', 'FX'], ['bank', '银行'], ['settings', '设置']];
const CHEV = '<svg width="12" height="20" viewBox="0 0 12 20"><path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const nav = (title, { back, right = '' } = {}) =>
  `<div class="mip-nav">${back ? `<button class="mip-back" data-a="back">${CHEV}<span>${esc(back)}</span></button>` : '<span></span>'}<div class="mip-nav-r">${right}</div></div><h1 class="mip-h1">${esc(title)}</h1>`;

/* ---------- modal ---------- */
function modal({ title, msg = '', html = '', input, ok = '确定', cancel = '取消', danger, onMount, onOk }) {
  const ph = $('#mip-phone'); if (!ph) return;
  const el = document.createElement('div'); el.className = 'mip-modal';
  el.innerHTML = `<div class="mip-sheet"><div class="mip-sh-t">${esc(title)}</div>${msg ? `<div class="mip-sh-m">${msg}</div>` : ''}${input ? `<input class="mip-in" type="text" inputmode="decimal" placeholder="${esc(input.ph || '')}" value="${esc(input.val ?? '')}">` : ''}${html}<div class="mip-sh-b"><button data-m="c">${cancel}</button>${onOk ? `<button data-m="o" class="${danger ? 'dg' : 'pri'}">${ok}</button>` : ''}</div></div>`;
  ph.appendChild(el);
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b) { if (e.target === el) el.remove(); return; }
    if (b.dataset.m === 'c') return el.remove();
    if (onOk(el) !== false) el.remove();
  });
  onMount?.(el);
  const i = el.querySelector('input'); if (i) setTimeout(() => i.focus(), 50);
}
function askAmount(title, msg, max, cb) {
  modal({
    title, msg, input: { ph: '输入金额（USD）' },
    html: `<div class="mip-quick"><button data-q="max">最大 ${fmt(max)}</button></div>`, ok: '确认',
    onMount(el) { el.querySelector('[data-q]').onclick = () => { el.querySelector('.mip-in').value = String(max); }; },
    onOk(el) {
      const v = r2(parseFloat(el.querySelector('.mip-in').value));
      if (!(v > 0)) { toast('请输入有效金额'); return false; }
      if (v > max + 1e-9) { toast('超出可用额度'); return false; }
      cb(v); renderKeep(); return true;
    },
  });
}

/* ---------- views ---------- */
const S = { open: false, app: 'home', stack: [], p: {}, fxTab: 'mkt', busy: false };
const V = {
  home: {
    dark: true,
    render() {
      const n = new Date(), unread = Object.values(D().unread).reduce((a, b) => a + b, 0);
      return `<div class="mip-home"><div class="mip-widget"><div class="wd">${n.toLocaleDateString('zh-CN', { weekday: 'long' })}</div><div class="wt">${hhmm(n)}</div><div class="ws">${n.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} · 钱包 ${fmt(D().balance)}</div></div>
      <div class="mip-grid">${APPS.map(([id, name]) => `<div class="mip-ico" data-a="open" data-app="${id}"><div class="mip-icon">${ICONS[id]}</div>${id === 'contacts' && unread ? `<i class="mip-badge">${unread}</i>` : ''}<span>${name}</span></div>`).join('')}</div></div>`;
    },
  },
  wallet: {
    render() {
      const d = D(), debt = totalDebt(), net = r2(d.balance + d.fx.cash + fxValue(d) - debt);
      return `${nav('钱包', { back: '主屏幕', right: '<button class="mip-txt" data-a="adjust">调整</button>' })}<div class="mip-scroll">
      <div class="mip-bal"><div class="l">现金余额 · USD</div><div class="a">${fmt(d.balance)}</div><div class="s">净资产 ${fmt(net)}</div></div>
      <div class="mip-group"><div class="mip-row"><span>FX 账户现金</span><b>${fmt(d.fx.cash)}</b></div><div class="mip-row"><span>FX 持仓市值</span><b>${fmt(fxValue(d))}</b></div><div class="mip-row"><span>贷款欠款</span><b class="${debt ? 'dn' : ''}">${fmt(debt)}</b></div></div>
      <div class="mip-sec">最近交易</div><div class="mip-group">${d.ledger.length ? d.ledger.slice(0, 40).map(e => `<div class="mip-row"><span>${esc(e.memo)}<small>${dt(e.t)}</small></span><b class="${e.amt >= 0 ? 'up' : 'dn'}">${sgn(e.amt)}</b></div>`).join('') : '<div class="mip-empty">暂无交易。剧情里发生消费或收入时会自动记录。</div>'}</div></div>`;
    },
  },
  bank: {
    render() {
      const d = D(), L = d.loan, debt = totalDebt();
      return `${nav('银行', { back: '主屏幕' })}<div class="mip-scroll">
      <div class="mip-bal green"><div class="l">现金余额 · USD</div><div class="a">${fmt(d.balance)}</div><div class="s">FX 账户 ${fmt(d.fx.cash)}</div></div>
      <div class="mip-grid2"><button data-a="borrow">借款</button><button data-a="repay">还款</button><button data-a="tofx">转入 FX</button><button data-a="fromfx">FX 转出</button></div>
      <div class="mip-sec">贷款</div><div class="mip-group">
      <div class="mip-row"><span>待还总额</span><b class="${debt ? 'dn' : ''}">${fmt(debt)}</b></div>
      <div class="mip-row"><span>本金</span><b>${fmt(L.principal)}</b></div>
      <div class="mip-row"><span>已计利息</span><b>${fmt(L.accrued)}</b></div>
      <div class="mip-row"><span>年利率</span><b>${(APR * 100).toFixed(1)}%</b></div>
      <div class="mip-row"><span>剩余可借额度</span><b>${fmt(LOAN_MAX - L.principal)}</b></div></div>
      <p class="mip-foot">利息按现实时间逐日累计（单利）。还款先抵利息，再抵本金。贷款总本金上限 ${fmt(LOAN_MAX)}。</p></div>`;
    },
  },
  appstore: {
    cats: [['生产力', '#ff9f0a'], ['社交', '#0a84ff'], ['游戏', '#bf5af2'], ['财务', '#30d158'], ['摄影', '#ff453a'], ['音乐', '#ff375f'], ['旅行', '#64d2ff'], ['健康', '#ff6482']],
    apps: [['Notes+', '生产力'], ['Focus Timer', '生产力'], ['Chatter', '社交'], ['Circle', '社交'], ['Pixel Quest', '游戏'], ['Block Rush', '游戏'], ['Ledger', '财务'], ['Pocket Budget', '财务'], ['Lens Pro', '摄影'], ['Tunebox', '音乐'], ['Wander', '旅行'], ['Pulse', '健康']],
    render() {
      const q = (S.p.q || '').trim().toLowerCase(), cat = S.p.cat;
      let list = this.apps.filter(a => (!cat || a[1] === cat) && (!q || a[0].toLowerCase().includes(q) || a[1].includes(q)));
      return `${nav('App Store', { back: '主屏幕' })}<div class="mip-scroll"><input class="mip-search" id="asq" placeholder="游戏、App 及更多内容" value="${esc(S.p.q || '')}">
      ${q || cat ? '' : `<div class="mip-feature"><small>今日推荐</small><b>更多应用，即将到来</b><span>下载功能正在开发中</span></div><div class="mip-sec">分类</div><div class="mip-cats">${this.cats.map(([n, c]) => `<div class="cat" data-a="cat" data-c="${n}"><i style="background:${c}"></i>${n}</div>`).join('')}</div>`}
      <div class="mip-sec">${cat ? esc(cat) + ' ' : ''}${q ? '搜索结果' : '热门'} <button class="mip-txt" data-a="cat" data-c="" ${cat ? '' : 'hidden'}>全部</button></div>
      <div class="mip-group">${list.length ? list.map(a => `<div class="mip-row"><div class="mip-appi" style="background:hsl(${hue(a[0])} 60% 55%)">${esc(a[0][0])}</div><span>${esc(a[0])}<small>${a[1]}</small></span><button class="mip-get" data-a="get">获取</button></div>`).join('') : '<div class="mip-empty">没有找到相关内容</div>'}</div></div>`;
    },
    mount(el) {
      const i = el.querySelector('#asq'); if (!i) return;
      const apply = () => { S.p.q = i.value; const pos = i.selectionStart; render(); const n = $('#asq'); n.focus(); n.setSelectionRange(pos, pos); };
      i.addEventListener('input', e => { if (!e.isComposing) apply(); });
      i.addEventListener('compositionend', apply);
    },
  },
  contacts: {
    render() {
      const d = D();
      return `${nav('联系人', { back: '主屏幕', right: '<button class="mip-ib" data-a="refc" title="刷新"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button><button class="mip-ib" data-a="csets" title="设置"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg></button>' })}
      <div class="mip-scroll"><div class="mip-group">${d.contacts.length ? d.contacts.map(c => `<div class="mip-row tap" data-a="chat" data-id="${c.id}">${avatar(c)}<span>${esc(c.name)}</span>${d.unread[c.id] ? `<i class="mip-dot">${d.unread[c.id]}</i>` : ''}</div>`).join('') : '<div class="mip-empty">还没有联系人。剧情里双方确认交换联系方式后会自动添加，也可以点右上角刷新。</div>'}</div></div>`;
    },
  },
  csets: {
    render() {
      const g = G(), d = D();
      return `${nav('联系人设置', { back: '联系人' })}<div class="mip-scroll"><div class="mip-sec">回复长度</div>
      <div class="mip-seg">${Object.entries(LEN).map(([k, v]) => `<button data-a="len" data-k="${k}" class="${g.replyLen === k ? 'on' : ''}">${v.label}</button>`).join('')}</div>
      <div class="mip-sec">头像（点击更换）</div><div class="mip-group">${d.contacts.length ? d.contacts.map(c => `<div class="mip-row tap" data-a="av" data-id="${c.id}">${avatar(c)}<span>${esc(c.name)}</span>${c.avatar ? `<button class="mip-txt" data-a="avrst" data-id="${c.id}">恢复默认</button>` : ''}</div>`).join('') : '<div class="mip-empty">暂无联系人</div>'}</div></div>`;
    },
  },
  chat: {
    render() {
      const c = findContact(S.p.id); if (!c) return `${nav('', { back: '联系人' })}`;
      return `<div class="mip-nav chat"><button class="mip-back" data-a="back">${CHEV}<span>联系人</span></button><div class="ct">${avatar(c, 'sm')}<span>${esc(c.name)}</span></div><span class="w"></span></div>
      <div class="mip-msgs" id="msgs"></div><div class="mip-compose"><input id="cin" placeholder="发送消息" autocomplete="off"><button data-a="send">↑</button></div>`;
    },
    mount() { D().unread[S.p.id] = 0; paintMsgs(S.busy); },
  },
  settings: {
    render() {
      const g = G(), a = g.api;
      return `${nav('设置', { back: '主屏幕' })}<div class="mip-scroll"><div class="mip-sec">AI 渠道</div><div class="mip-group">
      <label class="mip-row"><span>URL</span><input data-g="api.url" value="${esc(a.url)}" placeholder="https://xxx.com/v1"></label>
      <label class="mip-row"><span>API Key</span><input type="password" data-g="api.key" value="${esc(a.key)}" placeholder="sk-..."></label>
      <label class="mip-row"><span>模型</span><input data-g="api.model" value="${esc(a.model)}" placeholder="模型名称"></label></div>
      <div class="mip-grid2 two"><button data-a="models">获取模型</button><button data-a="test">测试连接</button></div>
      <div class="mip-sec">通用</div><div class="mip-group"><label class="mip-row"><span>向 AI 注入钱包提示<small>让剧情知道你的余额并输出记账标记</small></span><input type="checkbox" class="mip-sw" data-g="inject" ${g.inject ? 'checked' : ''}></label></div>
      <div class="mip-sec">数据</div><div class="mip-group"><div class="mip-row tap dn" data-a="reset">重置当前角色卡的小手机数据</div></div>
      <p class="mip-foot">每个角色卡拥有独立的钱包、银行、FX 和联系人数据。</p></div>`;
    },
  },
  fx: {
    dark: true,
    render() {
      const t = S.fxTab, F = D().fx;
      const tabs = [['mkt', '行情'], ['port', '持仓'], ['log', '记录']].map(([k, n]) => `<button data-a="fxtab" data-k="${k}" class="${t === k ? 'on' : ''}">${n}</button>`).join('');
      let body = '';
      if (t === 'mkt') body = `<div class="fx-sym">AURA</div><div class="fx-name">Aurora Technologies</div><div class="fx-price" id="fxp"></div><div class="fx-chg" id="fxc"></div><canvas id="fxcv"></canvas><div class="fx-mini" id="fxm"></div><div class="fx-btns"><button class="buy" data-a="fxbuy">买入</button><button class="sell" data-a="fxsell">卖出</button></div>`;
      else if (t === 'port') body = `<div id="fxport">${portHtml()}</div>`;
      else body = `<div class="mip-group">${F.log.length ? F.log.slice(0, 80).map(x => `<div class="mip-row"><span><b class="${x.side === 'BUY' ? 'up' : 'dn'}">${x.side === 'BUY' ? '买入' : '卖出'}</b> ${x.q} 股 @ ${fmt(x.px)}<small>${dt(x.t)} · 手续费 ${fmt(x.fee)}</small></span>${x.pl != null ? `<b class="${plCls(x.pl)}">${sgn(x.pl)}<small>${x.pct >= 0 ? '+' : ''}${x.pct}%</small></b>` : ''}</div>`).join('') : '<div class="mip-empty">还没有交易记录</div>'}</div>`;
      return `<div class="mip-fxwrap"><div class="mip-nav fx"><button class="mip-back" data-a="back">${CHEV}<span>主屏幕</span></button><div class="mip-seg dk">${tabs}</div><span class="w"></span></div><div class="mip-scroll fxs">${body}</div></div>`;
    },
    mount() { ensureFx(); paintFx(); clearInterval(fxTimer); fxTimer = setInterval(liveTick, TICK_MS); },
    unmount() { clearInterval(fxTimer); fxTimer = null; save(); },
  },
};

/* ---------- navigation ---------- */
function unmountCur() { V[S.app]?.unmount?.(); }
function render(anim) {
  const el = $('#mip-app'); if (!el) return;
  const v = V[S.app];
  el.innerHTML = `<div class="mip-view${anim ? ' in' : ''}">${v.render()}</div>`;
  $('#mip-phone').dataset.sb = v.dark ? 'l' : 'd';
  v.mount?.(el);
}
function renderKeep() { if (S.open && S.app !== 'chat' && S.app !== 'settings') render(); else if (S.open && S.app === 'chat') paintMsgs(S.busy); }
function go(app, p = {}) { unmountCur(); S.stack.push([S.app, S.p]); S.app = app; S.p = p; render(true); }
function back() { unmountCur(); const pv = S.stack.pop(); if (pv) [S.app, S.p] = pv; else { S.app = 'home'; S.p = {}; } render(true); }
function toHome() { unmountCur(); S.stack = []; S.app = 'home'; S.p = {}; render(true); }

const A = {
  open: el => { if (el.dataset.app === 'fx') S.fxTab = 'mkt'; go(el.dataset.app); },
  back: () => back(),
  homebar: () => (S.app === 'home' ? closePhone() : toHome()),
  adjust: () => modal({ title: '手动调整余额', msg: '正数增加，负数减少', input: { ph: '例如 500 或 -200' }, onOk(el) { const v = r2(parseFloat(el.querySelector('.mip-in').value)); if (!v) { toast('请输入金额'); return false; } if (addTx(v, '手动调整')) renderKeep(); else return false; } }),
  borrow: () => { accrue(); const room = LOAN_MAX - D().loan.principal; if (room <= 0) return toast('已达到贷款上限'); askAmount('借款', `年利率 ${(APR * 100).toFixed(1)}%，最多还可借 ${fmt(room)}`, room, v => { const L = D().loan; L.principal = r2(L.principal + v); addTx(v, '银行放款'); toast('已到账 ' + fmt(v)); }); },
  repay: () => { const debt = totalDebt(), max = Math.min(debt, D().balance); if (debt <= 0) return toast('当前没有贷款'); if (max <= 0) return toast('现金余额不足'); askAmount('还款', `待还 ${fmt(debt)}，先还利息再还本金`, max, v => { if (!addTx(-v, '偿还贷款')) return; const L = D().loan, i = Math.min(v, L.accrued); L.accrued = r2(L.accrued - i); L.principal = r2(Math.max(0, L.principal - (v - i))); toast('已还款 ' + fmt(v)); }); },
  tofx: () => { const b = D().balance; if (b <= 0) return toast('现金余额不足'); askAmount('转入 FX 账户', '资金将从钱包转入证券账户', b, v => { if (addTx(-v, '转入 FX 账户')) D().fx.cash = r2(D().fx.cash + v); }); },
  fromfx: () => { const c = D().fx.cash; if (c <= 0) return toast('FX 账户没有可转出的现金'); askAmount('从 FX 转出', '资金将转回钱包', c, v => { D().fx.cash = r2(D().fx.cash - v); addTx(v, 'FX 转出'); }); },
  cat: el => { S.p.cat = el.dataset.c || ''; render(); },
  get: () => toast('下载功能即将开放'),
  refc: () => refreshContacts(),
  csets: () => go('csets'),
  len: el => { G().replyLen = el.dataset.k; save(); render(); },
  av: el => pickAvatar(el.dataset.id),
  avrst: (el, e) => { e.stopPropagation(); const c = findContact(el.dataset.id); if (c) { c.avatar = ''; save(); render(); } },
  chat: el => go('chat', { id: el.dataset.id }),
  send: () => sendChat(),
  fxtab: el => { S.fxTab = el.dataset.k; render(); paintFx(); },
  fxbuy: () => tradeSheet('buy'),
  fxsell: () => { if (!D().fx.shares) return toast('当前没有持仓'); tradeSheet('sell'); },
  test: async () => { toast('连接中…'); try { const r = await ai([{ role: 'user', content: 'Reply with: ok' }], 10); toast('连接成功：' + r.slice(0, 20)); } catch (e) { toast('失败：' + e.message.slice(0, 80)); } },
  models: async () => {
    const a = G().api; if (!a.url || !a.key) return toast('请先填写 URL 和 Key');
    try {
      const base = a.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + a.key.trim() } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ids = ((await r.json()).data || []).map(m => m.id).sort().slice(0, 80);
      if (!ids.length) return toast('没有获取到模型列表，请手动填写');
      modal({ title: '选择模型', html: `<div class="mip-group mlist">${ids.map(i => `<div class="mip-row tap" data-id="${esc(i)}">${esc(i)}</div>`).join('')}</div>`,
        onMount(el) { el.querySelectorAll('[data-id]').forEach(r => r.onclick = () => { G().api.model = r.dataset.id; save(); el.remove(); render(); }); } });
    } catch (e) { toast('获取失败：' + e.message.slice(0, 60)); }
  },
  reset: () => modal({ title: '重置数据？', msg: '当前角色卡的钱包、贷款、FX、联系人和聊天记录都会被清空，无法恢复。', ok: '重置', danger: true, onOk() { delete M().cards[cardKey()]; save(); refreshPrompt(); toHome(); toast('已重置'); } }),
};

/* ---------- shell ---------- */
const statusIcons = `<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="7" rx="1" fill="currentColor"/><rect x="10" y="2.5" width="3" height="9.5" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg><svg width="26" height="12" viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3.5" fill="none" stroke="currentColor" opacity=".45"/><rect x="2" y="2" width="19" height="8" rx="2.2" fill="currentColor"/><rect x="24" y="4" width="2" height="4" rx="1" fill="currentColor" opacity=".45"/></svg>`;
let clockT;
function openPhone() {
  if (S.open) return;
  S.open = true;
  const m = document.createElement('div'); m.id = 'mip-mask';
  m.innerHTML = `<div id="mip-phone" data-sb="l"><div class="mip-island"></div><div class="mip-status"><b id="mip-clock">${hhmm(Date.now())}</b><div>${statusIcons}</div></div><div id="mip-app"></div><div class="mip-hbar" data-a="homebar"><i></i></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => { if (e.target === m) closePhone(); });
  m.addEventListener('touchstart', e => { if (e.target === m) closePhone(); }, { passive: true });
  const ph = $('#mip-phone');
  ph.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (el) A[el.dataset.a]?.(el, e); });
  ph.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'cin') { e.preventDefault(); sendChat(); } });
  const onField = e => {
    const k = e.target.dataset?.g; if (!k) return;
    const path = k.split('.'), g = G(), last = path.pop(); let o = g; path.forEach(p => { o = o[p]; });
    o[last] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
    save(); if (k === 'inject') refreshPrompt();
  };
  ph.addEventListener('input', onField); ph.addEventListener('change', onField);
  S.app = 'home'; S.stack = []; S.p = {}; render(true);
  clockT = setInterval(() => { const c = $('#mip-clock'); if (c) c.textContent = hhmm(Date.now()); }, 20000);
}
function closePhone() {
  unmountCur(); clearInterval(clockT);
  $('#mip-mask')?.remove(); S.open = false; save();
}
function mountFab() {
  const f = document.createElement('div'); f.id = 'mip-fab';
  f.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="6" y="2" width="12" height="20" rx="3" fill="none" stroke="#fff" stroke-width="1.8"/><rect x="10" y="4" width="4" height="1.4" rx=".7" fill="#fff"/></svg>`;
  document.body.appendChild(f);
  const clamp = (x, y) => [Math.max(4, Math.min(innerWidth - 52, x)), Math.max(4, Math.min(innerHeight - 52, y))];
  const pos = G().fab || [innerWidth - 60, innerHeight * 0.55];
  [f.style.left, f.style.top] = clamp(...pos).map(v => v + 'px');
  let sx, sy, ox, oy, moved = false;
  f.addEventListener('pointerdown', e => { f.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = f.offsetLeft; oy = f.offsetTop; moved = false; });
  f.addEventListener('pointermove', e => {
    if (!f.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 6) moved = true;
    if (moved) { const [x, y] = clamp(ox + e.clientX - sx, oy + e.clientY - sy); f.style.left = x + 'px'; f.style.top = y + 'px'; }
  });
  f.addEventListener('pointerup', e => {
    f.releasePointerCapture(e.pointerId);
    if (moved) { G().fab = [f.offsetLeft, f.offsetTop]; save(); } else (S.open ? closePhone() : openPhone());
  });
}

/* ---------- init ---------- */
function onChatChanged() {
  refreshPrompt();
  if (S.open) { if (S.app === 'fx') unmountCur(); S.stack = []; S.app = 'home'; S.p = {}; render(true); }
  setTimeout(stripDom, 600);
}
function init() {
  try {
    const c = X(), E = c.eventSource, T = c.eventTypes;
    mountFab(); refreshPrompt();
    E.on(T.CHAT_CHANGED, onChatChanged);
    E.on(T.MESSAGE_RECEIVED, i => { applyMessage(i); setTimeout(stripDom, 300); });
    E.on(T.MESSAGE_SWIPED, i => { applyMessage(i); setTimeout(stripDom, 300); });
    E.on(T.MESSAGE_EDITED, i => { applyMessage(i); setTimeout(stripDom, 300); });
    E.on(T.CHARACTER_MESSAGE_RENDERED, () => setTimeout(stripDom, 50));
    console.log('[My iPhone] loaded');
  } catch (e) { console.error('[My iPhone] init failed', e); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

/* My iPhone — SillyTavern extension (v0.1.0) */
(() => {
'use strict';

const MOD = 'my_iphone';
const FEE = 0.002, SPREAD = 0.0005, LOAN_MAX = 500000, APR = 0.08, DEP_APR = 0.016;
const LIQ_MAINT = 0.02, LIQ_FEE = 0.01, COL_AT = 10000, COL_CLEAR = 5000, COL_DAYS = 7;
const LEVS = [0, 2, 5, 10, 20], TIERS = [0.1, 0.25, 0.5, 0.75, 1];
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
const sTime = t => new Date(t).toLocaleTimeString('zh-CN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
const sDate = t => new Date(t).toLocaleDateString('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
const sWeek = t => new Date(t).toLocaleDateString('zh-CN', { timeZone: 'UTC', weekday: 'long' });
const sDT = t => new Date(t).toLocaleString('zh-CN', { timeZone: 'UTC', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const SPEEDS = [[1 / 3, '8 小时'], [1, '1 天'], [3, '3 天'], [7, '7 天'], [30, '30 天']];
const same = (a, b) => Math.abs(a - b) < 1e-6;
function parseStoryTime(str, loose) {
  const re = loose ? /(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?(?:\D{0,6}(\d{1,2}):(\d{2}))?/ : /(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2})\D+(\d{1,2}))?/;
  const m = String(str || '').match(re); if (!m) return null;
  const y = +m[1], mo = +m[2], da = +m[3], h = m[4] === undefined ? 12 : +m[4], mi = m[5] === undefined ? 0 : +m[5];
  if (y < 1000 || y > 3000 || mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  return Date.UTC(y, mo - 1, da, h, mi);
}
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
  m.global.daySpeed ??= 1;
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
  balance: 0, ledger: [], story: null, bankSt: null, frac: 0, day: 0, earned: 0, black: false, neg: 0, col: null, dayDone: [], tier: 'normal',
  loan: { principal: 0, accrued: 0 },
  fx: { cash: 0, shares: 0, avg: 0, price: 100, candles: [], cur: null, n: 0, regime: null, t: Date.now(), log: [], margin: 0, lev: 0 },
  contacts: [], chats: {}, unread: {},
});
function D() {
  const m = M(), k = cardKey();
  const d = (m.cards[k] ??= newCard());
  if (d.day === undefined || d.fx.margin === undefined || d.story === undefined) {
    const n = newCard();
    for (const key of Object.keys(n)) if (d[key] === undefined) d[key] = n[key];
    for (const key of Object.keys(n.fx)) if (d.fx[key] === undefined) d.fx[key] = n.fx[key];
  }
  return d;
}

/* ---------- toast ---------- */
let toastT;
function toast(msg) {
  let el = $('#mip-toast');
  if (!el) { el = document.createElement('div'); el.id = 'mip-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600);
}

/* ---------- bank logic ---------- */
function addTx(amt, memo, src) {
  const d = D(); amt = r2(amt);
  if (!amt) return false;
  if (amt < 0) {
    if (d.black) { toast('账户已冻结，无法消费'); return false; }
    if (d.balance + amt < -1e-9) { toast('余额不足：' + memo); return false; }
  }
  let bal = amt, debt = 0;
  if (amt > 0 && d.black) { debt = r2(Math.min(amt, d.neg)); bal = r2(amt - debt); d.neg = r2(d.neg - debt); }
  d.balance = r2(d.balance + bal);
  d.ledger.unshift({ id: uid(), t: Date.now(), st: d.story?.t ?? null, amt, memo, src: src || null, bal, debt });
  if (d.ledger.length > 100) d.ledger.length = 100;
  if (d.black && d.neg <= 0.004) recover();
  checkTier(); save(); refreshPrompt(); return true;
}
function undoSrc(src) {
  const d = D(), gone = d.ledger.filter(e => e.src === src);
  if (!gone.length) return;
  gone.forEach(e => { d.balance = r2(d.balance - (e.bal ?? e.amt)); d.neg = r2(d.neg + (e.debt || 0)); });
  d.ledger = d.ledger.filter(e => e.src !== src);
  if (d.neg > 0.004 && !d.black) d.black = true;
}
const totalDebt = () => { const L = D().loan; return r2(L.principal + L.accrued); };
const netWorth = d => r2(d.balance + d.fx.cash + fxValue(d) - d.loan.principal - d.loan.accrued - d.neg - d.fx.margin);
function recover() {
  const d = D(); d.black = false; d.neg = 0;
  toast('债务已还清，银行账户已恢复正常');
  bankSms('您的欠款已全部结清，账户已解除冻结，欢迎继续使用。', true);
}
function bankSms(text, quiet) {
  const d = D();
  let c = d.contacts.find(x => x.sys === 'bank');
  if (!c) { c = { id: 'bank', name: '银行客户经理', avatar: '', t: Date.now(), sys: 'bank' }; d.contacts.unshift(c); }
  (d.chats[c.id] ??= []).push({ r: 'them', text, t: Date.now() });
  if (!(S.open && S.app === 'chat' && S.p.id === c.id)) d.unread[c.id] = (d.unread[c.id] || 0) + 1;
  if (!quiet) toast('银行：' + text.slice(0, 32));
  save(); renderKeep();
}
function goBlack(extra = 0) {
  const d = D(), L = d.loan;
  let debt = r2(L.principal + L.accrued + extra + d.neg);
  L.principal = 0; L.accrued = 0; d.col = null;
  const seize = r2(Math.min(d.balance, debt));
  d.balance = r2(d.balance - seize); debt = r2(debt - seize);
  if (debt > 0.004) { d.black = true; d.neg = debt; } else { d.black = false; d.neg = 0; }
  checkTier(); refreshPrompt(); return d.black;
}
function settleDeficit(def, why, quiet) {
  const d = D(); let r = r2(def); const notes = [];
  if (d.black) { d.neg = r2(d.neg + r); notes.push('计入欠款 ' + fmt(r)); }
  else {
    const take = r2(Math.min(d.balance, r));
    if (take > 0) {
      d.balance = r2(d.balance - take); r = r2(r - take);
      d.ledger.unshift({ id: uid(), t: Date.now(), amt: -take, memo: why + '补缴', src: null, bal: -take, debt: 0 });
      notes.push('扣除存款 ' + fmt(take));
    }
    if (r > 0) {
      const draw = r2(Math.min(LOAN_MAX - d.loan.principal, r));
      if (draw > 0) { d.loan.principal = r2(d.loan.principal + draw); r = r2(r - draw); notes.push('强制贷款 ' + fmt(draw)); }
    }
    if (r > 0) { goBlack(r); notes.push('贷款额度用尽，剩余 ' + fmt(r) + ' 计入欠款，账户已冻结'); }
  }
  checkTier(); save(); refreshPrompt();
  bankSms(`您的账户因${why}产生欠款 ${fmt(def)}。处理结果：${notes.join('；')}。`, quiet);
}
function collectionCheck(d) {
  const L = d.loan;
  if (d.black) { d.col = null; return; }
  if (!d.col) {
    if (L.accrued >= COL_AT) {
      d.col = { due: d.day + COL_DAYS, warned: false };
      bankSms(`【催收通知】您的贷款已产生利息 ${fmt(L.accrued)}。请在 ${COL_DAYS} 天内（${dueLabel(d)}前）还款，将已计利息降至 ${fmt(COL_CLEAR)} 以下，逾期将冻结账户并列入黑名单。`);
    }
    return;
  }
  if (L.accrued < COL_CLEAR) { d.col = null; bankSms('已确认您的还款，利息已降至规定线以下，催收解除。'); return; }
  if (d.day >= d.col.due) {
    const bk = goBlack();
    bankSms(bk ? `【账户冻结】您未在期限内还款，账户已冻结并列入黑名单。当前欠款 ${fmt(d.neg)}，今后收入将自动抵扣，冻结期间免息。` : '【催收结案】您逾期未还，银行已扣划存款抵偿全部贷款。');
    return;
  }
  if (!d.col.warned && d.day >= d.col.due - 2) { d.col.warned = true; bankSms(`【最后提醒】距催收期限仅剩 ${d.col.due - d.day} 天，请尽快还款。`); }
}
function advanceDays(n) {
  const d = D(); d.frac = (d.frac || 0) + n;
  const total = Math.floor(d.frac + 1e-9), whole = Math.min(3650, total);
  d.frac = Math.max(0, d.frac - total);
  for (let i = 0; i < whole; i++) {
    d.day++;
    if (!d.black) {
      const it = r2(d.balance * DEP_APR / 365);
      if (it > 0) { d.balance = r2(d.balance + it); d.earned = r2(d.earned + it); }
      if (d.loan.principal > 0) d.loan.accrued = r2(d.loan.accrued + d.loan.principal * APR / 365);
    }
    collectionCheck(d);
  }
  checkTier(); save(); refreshPrompt();
}
function setStoryTime(t) {
  const d = D(); d.story = { t };
  if (G().followStory) {
    if (d.bankSt == null) d.bankSt = t;
    else if (t > d.bankSt) { const days = (t - d.bankSt) / 864e5; d.bankSt = t; advanceDays(days); }
  }
  save(); refreshPrompt(); if (S.open && S.app === 'home') render();
}
const dueLabel = d => (G().followStory && d.story ? sDate(d.story.t + (d.col.due - d.day) * 864e5) : '第 ' + d.col.due + ' 天');
const phoneClock = () => (D().story ? sTime(D().story.t) : '--:--');
const TIER_ORDER = ['normal', 'bronze', 'silver', 'gold', 'diamond', 'starry'];
const CARD_TIERS = [[5e6, 'starry', '星空卡'], [3e6, 'diamond', '钻石卡'], [1e6, 'gold', '黄金卡'], [5e5, 'silver', '白银卡'], [2e5, 'bronze', '青铜卡']];
function cardTier(d) {
  if (d.black) return ['black', '已冻结'];
  for (const t of CARD_TIERS) if (d.balance >= t[0]) return [t[1], t[2]];
  return ['normal', '标准卡'];
}
function nextTier(d) { if (d.black) return null; for (const t of [...CARD_TIERS].reverse()) if (d.balance < t[0]) return t; return null; }
function checkTier() {
  const d = D(), t = cardTier(d);
  if (d.tier && d.tier !== t[0] && TIER_ORDER.indexOf(t[0]) > TIER_ORDER.indexOf(d.tier)) toast('银行卡升级为「' + t[1] + '」');
  d.tier = t[0];
}
const STAR_SVG = (() => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let o = '<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>';
  for (let i = 0; i < 36; i++) {
    const x = (rnd() * 320).toFixed(1), y = (rnd() * 200).toFixed(1), r = (0.6 + rnd() * 1.5).toFixed(1);
    o += i % 4 === 0 ? `<circle class="tw" cx="${x}" cy="${y}" r="${r}" fill="#fff" style="animation-delay:${(rnd() * 3).toFixed(1)}s"/>` : `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${(0.3 + rnd() * 0.6).toFixed(2)}"/>`;
  }
  return o + '<path d="M236 34L296 16" stroke="url(#sg)" stroke-width="1.6" stroke-linecap="round"/><circle cx="296" cy="16" r="2.2" fill="#fff"/><path d="M262 118a22 22 0 1 0 22 26a17 17 0 1 1-22-26z" fill="#fff" opacity=".12"/></svg>';
})();
const DIAMOND_SVG = '<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><g fill="rgba(255,255,255,.2)"><polygon points="228,38 278,38 304,74 253,132 202,74"/></g><g fill="rgba(255,255,255,.32)"><polygon points="228,38 253,74 202,74"/><polygon points="278,38 304,74 253,74"/></g><g fill="rgba(110,150,255,.25)"><polygon points="202,74 253,74 253,132"/><polygon points="253,74 304,74 253,132"/></g><g stroke="rgba(255,255,255,.6)" stroke-width="1" fill="none"><polygon points="228,38 278,38 304,74 253,132 202,74"/><path d="M202 74H304M228 38L253 74L278 38M253 74V132"/></g><g fill="rgba(255,255,255,.55)"><polygon points="60,150 68,142 76,150 68,162"/><polygon points="110,168 115,162 120,168 115,176"/></g></svg>';
function cardNum() { let h = 0; for (const ch of cardKey()) h = (h * 131 + ch.charCodeAt(0)) % 9000; return 1000 + h; }
function cardHtml(d) {
  const [t, label] = cardTier(d), deco = t === 'starry' ? STAR_SVG : t === 'diamond' ? DIAMOND_SVG : '';
  return `<div class="mip-card t-${t}"><div class="cd">${deco}</div><div class="c-top"><span>My iPhone Bank</span><span class="c-tier">${label}</span></div><div class="c-chip"></div><div class="c-bal"><small>${d.black ? '账户冻结 · 欠款' : '可用余额 · USD'}</small><b>${fmt(d.black ? -d.neg : d.balance)}</b></div><div class="c-bot"><span>•••• ${cardNum()}</span><span>${esc((X().name1 || 'USER').toUpperCase())}</span></div></div>`;
}
function bankFacts() {
  const d = D(), L = d.loan;
  return `Bank day ${d.day}. Loan principal ${fmt(L.principal)}, accrued interest ${fmt(L.accrued)} (APR 8%). Deposit ${fmt(d.balance)} (APR 1.6%). ` +
    (d.col ? `A collection notice is active: accrued interest must be below ${fmt(COL_CLEAR)} within ${Math.max(0, d.col.due - d.day)} days, otherwise the account is frozen and blacklisted. ` : '') +
    (d.black ? `The account is frozen (blacklisted) with outstanding debt ${fmt(d.neg)}; interest-free; new income automatically repays it.` : '');
}

/* ---------- FX simulation ---------- */
function newRegime() {
  const k = Math.random(), len = 25 + Math.floor(-Math.log(1 - Math.random()) * 110);
  const vols = [0.0011, 0.0016, 0.0024, 0.0038];
  const vol = vols[k < 0.3 ? 0 : k < 0.65 ? 1 : k < 0.9 ? 2 : 3];
  const drift = Math.random() < 0.25 ? 0 : (Math.random() - 0.5) * 0.0005;
  return { drift, vol, left: len };
}
function tickPrice(F, p) {
  if (!F.regime || --F.regime.left <= 0) F.regime = newRegime();
  F.h = (F.h || 0) * 0.994 + gauss() * 0.05;                                   // volatility clustering
  F.fair = Math.min(400, Math.max(30, (F.fair || p) * (1 + 0.00008 * gauss()))); // wandering fair value
  let ret = F.regime.drift + F.regime.vol * Math.exp(F.h) * gauss();
  if (Math.random() < 0.012) ret *= 2 + Math.random() * 3;                      // fat tails
  F.mom = (F.mom || 0) * 0.96 + ret;
  ret -= 0.04 * F.mom * Math.random();                                          // unreliable exhaustion
  ret += 0.00012 * Math.log(F.fair / p);
  if (Math.random() < 0.0012) ret += (Math.random() < 0.65 ? -1 : 1) * Math.sign(F.mom || 1) * (0.015 + Math.random() * 0.08);
  return Math.max(1, Math.round(p * (1 + ret) * 100) / 100);
}
function stepCandle(F) {
  const o = F.price; let p = o, h = o, l = o;
  for (let i = 0; i < TPC; i++) { p = tickPrice(F, p); if (p > h) h = p; if (p < l) l = p; }
  F.price = p; F.candles.push([o, h, l, p]);
  if (F.candles.length > 240) F.candles.shift();
}
let fxQuiet = false;
function ensureFx() {
  const F = D().fx, now = Date.now();
  if (!F.candles.length) { F.price = 100; F.regime = null; for (let i = 0; i < 120; i++) stepCandle(F); }
  else {
    const n = Math.min(300, Math.floor((now - F.t) / (TICK_MS * TPC)));
    fxQuiet = true;
    for (let i = 0; i < n; i++) { stepCandle(F); checkLiq(F.candles[F.candles.length - 1][2]); }
    fxQuiet = false;
    if (n > 0) { F.cur = null; F.n = 0; }
  }
  F.t = now; return F;
}
const KK = (1 - SPREAD) * (1 - FEE);
const ask = F => F.price * (1 + SPREAD);
const bid = F => F.price * (1 - SPREAD);
const fxValue = d => r2(d.fx.shares * d.fx.price * KK);
const levMult = F => F.lev || 1;
const equity = F => r2(F.cash + F.shares * F.price * KK - F.margin);
const unreal = F => r2(F.shares * F.price * KK - F.shares * F.avg);
const plCls = n => (n >= 0 ? 'up' : 'dn');
function liqPrice(F) { if (!F.shares || F.margin <= F.cash) return 0; return (F.margin - F.cash) / (F.shares * KK * (1 - LIQ_MAINT)); }
function checkLiq(px) {
  const d = D(), F = d.fx;
  if (!F.shares || !(F.margin > 0)) return false;
  const mv = F.shares * px * KK;
  if (F.cash + mv - F.margin >= LIQ_MAINT * mv) return false;
  const gross = F.shares * px * (1 - SPREAD), fee = gross * (FEE + LIQ_FEE), net = gross - fee;
  const pl = r2(net - F.avg * F.shares);
  F.log.unshift({ t: Date.now(), side: 'LIQ', q: F.shares, px: r2(px * (1 - SPREAD)), fee: r2(fee), pl, pct: null });
  if (F.log.length > 200) F.log.length = 200;
  F.shares = 0; F.avg = 0;
  F.cash = r2(F.cash + net - F.margin); F.margin = 0;
  let def = 0; if (F.cash < 0) { def = -F.cash; F.cash = 0; }
  toast('⚠ 爆仓！已强制平仓' + (def > 0 ? '，并产生欠款，详见银行短信' : '，亏损 ' + fmt(Math.abs(pl))));
  if (def > 0) settleDeficit(def, '杠杆爆仓', true);
  save(); if (!fxQuiet) renderKeep();
  return true;
}
let fxTimer = null;
function schedTick() {
  fxTimer = setTimeout(() => { fxTimer = null; liveTick(); if (!fxTimer && S.open && S.app === 'fx') schedTick(); }, 450 + Math.random() * 1100);
}
function liveTick() {
  const F = D().fx;
  F.price = tickPrice(F, F.price);
  const c = F.cur ??= [F.price, F.price, F.price, F.price];
  c[3] = F.price; if (F.price > c[1]) c[1] = F.price; if (F.price < c[2]) c[2] = F.price;
  if (++F.n >= TPC) { F.candles.push(c); if (F.candles.length > 240) F.candles.shift(); F.cur = null; F.n = 0; }
  F.t = Date.now();
  if (checkLiq(F.price)) return;
  paintFx();
}
function sellQty(F) { return !F.shares ? 0 : S.sellTier >= 1 ? F.shares : Math.min(F.shares, Math.max(1, Math.floor(F.shares * S.sellTier))); }
function buyQty(F) { return Math.max(0, Math.floor(F.cash * S.buyTier * levMult(F) / (ask(F) * (1 + FEE)))); }
function paintFx() {
  const F = D().fx, cv = $('#fxcv'), pe = $('#fxp');
  if (pe) {
    const base = F.candles[0]?.[0] || F.price, ch = (F.price - base) / base * 100;
    pe.textContent = fmt(F.price);
    const ce = $('#fxc'); ce.textContent = (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch).toFixed(2) + '%'; ce.className = 'fx-chg ' + (ch >= 0 ? 'up' : 'dn');
    const me = $('#fxm');
    if (me) {
      const lq = liqPrice(F), eq = equity(F), mv = F.shares * F.price * KK;
      me.innerHTML = F.shares
        ? `持有 <b>${F.shares}</b> 股 · 成本 ${fmt(F.avg)} · 浮动 <b class="${plCls(unreal(F))}">${sgn(unreal(F))}</b>` + (F.margin > 0 ? `<br>实际杠杆 ${eq > 0 ? (mv / eq).toFixed(1) : '—'}X · 借款 ${fmt(F.margin)}${lq ? ` · 强平价 <b class="dn">${fmt(lq)}</b>` : ''}` : '')
        : '当前未持仓';
    }
    const es = $('#fxest');
    if (es) {
      const L = levMult(F), bq = buyQty(F), cost = bq * ask(F) * (1 + FEE);
      es.innerHTML = `买入 <b class="up">${bq}</b> 股 · 动用 ${fmt(cost / L)}${L > 1 ? ` · 名义 ${fmt(cost)}` : ''}<br>卖出 <b class="dn">${sellQty(F)}</b> 股 · 可卖 ${F.shares} 股${F.lev >= 10 ? '<br><span class="dn">高杠杆：价格小幅波动就可能爆仓</span>' : ''}`;
    }
  }
  const pb = $('#fxport'); if (pb) pb.innerHTML = portHtml();
  if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const arr = F.candles.slice(-60); if (F.cur) arr.push(F.cur);
  let lo = Math.min(...arr.map(c => c[2])), hi = Math.max(...arr.map(c => c[1]));
  const lq = liqPrice(F), showLq = lq > 0 && lq > F.price * 0.75;
  if (F.shares > 0) { lo = Math.min(lo, F.avg); hi = Math.max(hi, F.avg); }
  if (showLq) lo = Math.min(lo, lq);
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
  if (showLq) line(lq, '#ff453a', lq.toFixed(2));
}
function portHtml() {
  const d = D(), F = d.fx, mv = fxValue(d), un = unreal(F);
  const realized = r2(F.log.filter(x => x.pl != null).reduce((a, x) => a + x.pl, 0));
  const lq = liqPrice(F);
  return `<div class="mip-group">
    <div class="mip-row"><span>FX 账户现金</span><b>${fmt(F.cash)}</b></div>
    <div class="mip-row"><span>持仓</span><b>${F.shares} 股</b></div>
    <div class="mip-row"><span>持仓均价（含手续费）</span><b>${F.shares ? fmt(F.avg) : '—'}</b></div>
    <div class="mip-row"><span>持仓市值（扣费后）</span><b>${fmt(mv)}</b></div>
    <div class="mip-row"><span>融资借款</span><b class="${F.margin > 0 ? 'dn' : ''}">${fmt(F.margin)}</b></div>
    <div class="mip-row"><span>账户权益</span><b>${fmt(equity(F))}</b></div>
    <div class="mip-row"><span>强平价</span><b>${lq ? fmt(lq) : '—'}</b></div>
    <div class="mip-row"><span>浮动盈亏</span><b class="${plCls(un)}">${F.shares ? sgn(un) : '—'}</b></div>
    <div class="mip-row"><span>已实现盈亏</span><b class="${plCls(realized)}">${sgn(realized)}</b></div></div>
    <p class="mip-foot">资金请在「银行」App 转入。买入和卖出各收 0.2% 手续费，另有 0.05% 买卖价差。账户权益低于持仓市值的 2% 会被强制平仓并额外收取 1% 平仓费。</p>`;
}
function doBuy() {
  const F = D().fx, L = levMult(F), px = ask(F);
  if (F.cash <= 0) return toast('FX 账户没有资金，请先到银行转入');
  const q = buyQty(F);
  if (q <= 0) return toast('当前档位的资金不足以买入 1 股');
  const total = px * q * (1 + FEE), own = total / L;
  F.cash = r2(F.cash - own); F.margin = r2(F.margin + (total - own));
  F.avg = (F.avg * F.shares + total) / (F.shares + q); F.shares += q;
  F.log.unshift({ t: Date.now(), side: 'BUY', q, px: r2(px), fee: r2(px * q * FEE), pl: null, lev: L });
  if (F.log.length > 200) F.log.length = 200;
  save(); toast(`已买入 ${q} 股 @ ${fmt(px)}${L > 1 ? ' · ' + L + 'X' : ''}`);
  if (!checkLiq(F.price)) paintFx();
}
function doSell() {
  const F = D().fx;
  if (!F.shares) return toast('当前没有持仓');
  const q = sellQty(F), px = bid(F), gross = px * q, fee = gross * FEE, net = gross - fee;
  const repay = q === F.shares ? F.margin : r2(F.margin * q / F.shares);
  const ownCap = F.avg * q - repay, pl = r2(net - F.avg * q), pct = ownCap > 0 ? r2(pl / ownCap * 100) : 0;
  F.margin = r2(F.margin - repay); F.shares -= q; F.cash = r2(F.cash + net - repay);
  if (!F.shares) { F.avg = 0; F.margin = 0; }
  let def = 0; if (F.cash < 0) { def = -F.cash; F.cash = 0; }
  F.log.unshift({ t: Date.now(), side: 'SELL', q, px: r2(px), fee: r2(fee), pl, pct });
  if (F.log.length > 200) F.log.length = 200;
  save(); toast(`已卖出 ${q} 股 · ${sgn(pl)}`);
  if (def > 0) settleDeficit(def, '平仓亏损');
  paintFx();
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
  const money = d.black
    ? `- ${u}'s bank account is FROZEN (blacklisted, owes ${fmt(d.neg)}). ${u} has no cash and cannot pay for or buy anything. Any money ${u} earns automatically goes to repaying the debt (still report it with the tag below). Other characters do NOT know ${u}'s finances unless ${u} tells them.`
    : `- ${u}'s current cash: ${fmt(d.balance)} USD. Only ${u} knows this. Other characters do NOT know how much money ${u} has unless ${u} tells them or it is plainly visible.\n- ${u} cannot spend more than they have. If ${u} can't afford something, they can't buy it — write the scene accordingly.`;
  const known = d.story ? `Last known in-story time: ${new Date(d.story.t).toISOString().slice(0, 16).replace('T', ' ')} (time normally moves forward).` : 'The in-story time is not known yet; infer a plausible date and time from the story.';
  const txt = `[Phone & wallet system note — hidden, never mention or quote it in the story.
${money}
- EVERY reply must end with exactly ONE line of this form: [[PHONE:{"time":"YYYY-MM-DD HH:mm"}]]. "time" is the current in-story date and time at the end of your reply. If the character card shows a date/time (status panel, phone UI, etc.), copy it; otherwise infer it sensibly from the story so far. ${known}
- If money really changes hands, add "money" to that same JSON: "money":[{"amt":-25.5,"memo":"dinner"}] (negative = ${u} spends, positive = ${u} earns, USD).
- Only if ${u} and a character have BOTH clearly agreed to exchange contact info in your reply, add "contacts":["Name"]. If a saved contact texts ${u}, add "sms":[{"from":"Name","text":"..."}].
- Keep it as one single line of valid JSON at the very end.]`;
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
  const dd = D();
  let gotTime = false;
  for (const p of parseTags(msg.mes)) {
    if (p.time) { const t = parseStoryTime(p.time); if (t) { setStoryTime(t); gotTime = true; } }
    (p.money || []).forEach(x => { const a = Number(x.amt); if (isFinite(a)) addTx(a, String(x.memo || '剧情消费').slice(0, 40), src); });
    (p.contacts || []).forEach(n => addContact(String(n)));
    (p.sms || []).forEach(s => receiveSms(String(s.from || ''), String(s.text || ''), src));
  }
  if (!gotTime) { const t = parseStoryTime((msg.mes || '').replace(TAG_ALL, ''), true); if (t) setStoryTime(t); }
  if (!G().followStory && !dd.dayDone.includes(src)) { dd.dayDone.push(src); if (dd.dayDone.length > 80) dd.dayDone.shift(); advanceDays(G().daySpeed); }
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
  if (c.sys === 'bank') return `<div class="mip-av ${cls}" style="background:#14a44d"><span>银</span></div>`;
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
  if (c.sys === 'bank') return [{ role: 'system', content: `You are the account manager of "My iPhone Bank", texting ${X().name1} by phone message. Be professional, concise, firm but polite; reply in the language the customer uses (default Chinese). Do not invent policies beyond these facts: ${bankFacts()} ${LEN[G().replyLen].rule}` }, ...h.slice(-14).map(m => ({ role: m.r === 'me' ? 'user' : 'assistant', content: m.text }))];
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
  fx: `<svg viewBox="0 0 60 60"><defs><linearGradient id="gF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101c16"/><stop offset="1" stop-color="#000"/></linearGradient><linearGradient id="gM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#30d158" stop-opacity=".5"/><stop offset="1" stop-color="#30d158" stop-opacity="0"/></linearGradient></defs><rect width="60" height="60" fill="url(#gF)"/><path d="M0 16H60M0 30H60M0 44H60" stroke="#fff" stroke-opacity=".07"/><path d="M0 48L14 27L30 26L46 7L60 3V60H0Z" fill="url(#gM)"/><g stroke-linecap="round"><path d="M14 24V43" stroke="#30d158" stroke-width="2"/><rect x="10" y="28" width="8" height="11" rx="1.5" fill="#30d158"/><path d="M30 24V42" stroke="#ff453a" stroke-width="2"/><rect x="26" y="28" width="8" height="7" rx="1.5" fill="#ff453a"/><path d="M46 3V39" stroke="#30d158" stroke-width="2"/><rect x="42" y="7" width="8" height="28" rx="1.5" fill="#30d158"/></g></svg>`,
  bank: `<svg viewBox="0 0 60 60"><defs><linearGradient id="gB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4cd964"/><stop offset="1" stop-color="#14a44d"/></linearGradient></defs><rect width="60" height="60" fill="url(#gB)"/><path d="M30 11L50 22H10z" fill="#fff"/><g fill="#fff"><rect x="14" y="26" width="5" height="16" rx="1.5"/><rect x="23" y="26" width="5" height="16" rx="1.5"/><rect x="32" y="26" width="5" height="16" rx="1.5"/><rect x="41" y="26" width="5" height="16" rx="1.5"/><rect x="10" y="45" width="40" height="5" rx="2"/></g></svg>`,
  settings: `<svg viewBox="0 0 60 60"><defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8b8be"/><stop offset="1" stop-color="#6e6e75"/></linearGradient></defs><rect width="60" height="60" fill="url(#gS)"/><g fill="#2c2c2e" transform="translate(30 30)"><circle r="14"/>${[0, 45, 90, 135].map(a => `<rect x="-4" y="-20" width="8" height="40" rx="2" transform="rotate(${a})"/>`).join('')}</g><circle cx="30" cy="30" r="6" fill="#9a9aa0"/></svg>`,
};
const APPS = [['bank', '银行'], ['appstore', 'App Store'], ['contacts', '联系人'], ['fx', 'FX'], ['settings', '设置']];
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
const S = { open: false, app: 'home', stack: [], p: {}, fxTab: 'mkt', busy: false, buyTier: 0.25, sellTier: 0.5, as: { tab: 'home', q: '', cat: '' } };
const AS_APPS = [
  { n: 'FX', s: '模拟炒股 · 实时行情', c: '财务', h: 140, fx: true },
  { n: 'Orbit 日历', s: '把每一天安排得井井有条', c: '生产力', h: 215 },
  { n: 'Pixel Quest', s: '像素世界的冒险之旅', c: '游戏', h: 280 },
  { n: 'Tunebox', s: '随时随地的音乐库', c: '音乐', h: 340 },
  { n: 'Wander', s: '发现下一个目的地', c: '旅行', h: 175 },
  { n: 'Pulse 健康', s: '记录每天的心率与睡眠', c: '健康', h: 350 },
  { n: 'Lens Pro', s: '专业级手机摄影', c: '摄影', h: 25 },
  { n: 'Chatter', s: '和朋友畅聊', c: '社交', h: 200 },
  { n: 'Pocket Budget', s: '轻松记账与预算', c: '财务', h: 120 },
  { n: 'Block Rush', s: '指尖上的益智消除', c: '游戏', h: 300 },
  { n: 'Focus Timer', s: '番茄钟与专注统计', c: '生产力', h: 45 },
  { n: 'Circle', s: '同城兴趣小圈子', c: '社交', h: 255 },
];
const AS_FEAT = ['Orbit 日历', 'Pixel Quest', 'Tunebox', 'Wander'];
const AS_CATS = [['生产力', '#ff9f0a'], ['社交', '#0a84ff'], ['游戏', '#bf5af2'], ['财务', '#30d158'], ['摄影', '#ff453a'], ['音乐', '#ff375f'], ['旅行', '#64d2ff'], ['健康', '#ff6482']];
const asIcon = x => x.fx ? `<div class="mip-appi" style="padding:0;overflow:hidden">${ICONS.fx}</div>` : `<div class="mip-appi" style="background:linear-gradient(160deg,hsl(${x.h} 70% 62%),hsl(${(x.h + 30) % 360} 70% 44%))">${esc(x.n[0])}</div>`;
const TABI = {
  home: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  rank: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
  cat: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  me: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/>',
};
let asTimer = null;
const V = {
  home: {
    dark: true,
    render() {
      const st = D().story?.t, unread = Object.values(D().unread).reduce((a, b) => a + b, 0);
      return `<div class="mip-home"><div class="mip-widget"><div class="wd">${st ? sWeek(st) : '剧情时间'}</div><div class="wt">${st ? sTime(st) : '--:--'}</div><div class="ws">${st ? sDate(st) : '尚未同步，等待下一条回复'}</div></div>
      <div class="mip-grid">${APPS.map(([id, name]) => `<div class="mip-ico" data-a="open" data-app="${id}"><div class="mip-icon">${ICONS[id]}</div>${id === 'contacts' && unread ? `<i class="mip-badge">${unread}</i>` : ''}<span>${name}</span></div>`).join('')}</div></div>`;
    },
  },
  bank: {
    render() {
      const d = D(), L = d.loan, debt = totalDebt(), nt = nextTier(d), fx = d.fx;
      const warn = d.black ? '<div class="mip-warn bk">账户已冻结：无法消费、借款与转入；新收入会自动抵扣欠款，期间免息。</div>'
        : d.col ? `<div class="mip-warn">银行催收：还剩 <b>${Math.max(0, d.col.due - d.day)}</b> 天，须把已计利息还到 ${fmt(COL_CLEAR)} 以下，否则账户将被冻结。</div>` : '';
      const loanRows = d.black
        ? `<div class="mip-row"><span>欠款（贷款与亏损叠加）<small>冻结期间免息</small></span><b class="dn">${fmt(-d.neg)}</b></div>`
        : `<div class="mip-row"><span>待还总额</span><b class="${debt ? 'dn' : ''}">${fmt(debt)}</b></div>
           <div class="mip-row"><span>本金</span><b>${fmt(L.principal)}</b></div>
           <div class="mip-row"><span>已计利息</span><b>${fmt(L.accrued)}</b></div>
           <div class="mip-row"><span>年利率</span><b>${(APR * 100).toFixed(1)}%</b></div>
           <div class="mip-row"><span>剩余可借额度</span><b>${fmt(LOAN_MAX - L.principal)}</b></div>`;
      return `${nav('银行', { back: '主屏幕', right: '<button class="mip-txt" data-a="adjust">调整</button>' })}<div class="mip-scroll">${cardHtml(d)}
      ${nt ? `<p class="mip-foot cardhint">再存入 ${fmt(nt[0] - d.balance)} 可升级为「${nt[2]}」</p>` : ''}${warn}
      <div class="mip-grid2"><button data-a="borrow">借款</button><button data-a="repay">还款</button><button data-a="tofx">转入 FX</button><button data-a="fromfx">FX 转出</button></div>
      <div class="mip-sec">资产</div><div class="mip-group">
        <div class="mip-row"><span>活期存款<small>年利率 ${(DEP_APR * 100).toFixed(1)}%，余额自动计息</small></span><b>${fmt(d.balance)}</b></div>
        <div class="mip-row"><span>累计利息收入</span><b class="up">${sgn(d.earned)}</b></div>
        <div class="mip-row"><span>FX 账户现金</span><b>${fmt(fx.cash)}</b></div>
        <div class="mip-row"><span>FX 持仓市值</span><b>${fmt(fxValue(d))}</b></div>
        ${fx.margin > 0 ? `<div class="mip-row"><span>FX 融资借款</span><b class="dn">${fmt(fx.margin)}</b></div>` : ''}
        <div class="mip-row"><span>净资产</span><b>${fmt(netWorth(d))}</b></div></div>
      <div class="mip-sec">${d.black ? '债务' : '贷款'}</div><div class="mip-group">${loanRows}</div>
      <div class="mip-sec">最近交易</div><div class="mip-group">${d.ledger.length ? d.ledger.slice(0, 40).map(e => `<div class="mip-row"><span>${esc(e.memo)}<small>${e.st ? sDT(e.st) : dt(e.t)}${e.debt ? ' · 已抵扣欠款 ' + fmt(e.debt) : ''}</small></span><b class="${e.amt >= 0 ? 'up' : 'dn'}">${sgn(e.amt)}</b></div>`).join('') : '<div class="mip-empty">暂无交易。剧情里发生消费或收入时会自动记录。</div>'}</div>
      <p class="mip-foot">银行日期：第 ${d.day} 天${G().followStory ? '（跟随正文时间）' : `。每条 AI 回复推进 ${SPEEDS.find(x => same(x[0], G().daySpeed))?.[1] || G().daySpeed + ' 天'}（可在设置里调整）`}，利息每日结算。贷款本金上限 ${fmt(LOAN_MAX)}。</p></div>`;
    },
  },
  appstore: {
    render() {
      const a = S.as, q = a.q.trim().toLowerCase();
      const row = (x, rank) => `<div class="mip-row as-row">${rank ? `<i class="rk">${rank}</i>` : ''}${asIcon(x)}<span>${esc(x.n)}<small>${esc(x.s)}</small></span>${x.fx ? '<span class="as-inst">已安装</span>' : '<button class="mip-get" data-a="get">获取</button>'}</div>`;
      const slide = x => `<div class="as-slide" style="background:linear-gradient(145deg,hsl(${x.h} 72% 58%),hsl(${(x.h + 45) % 360} 70% 36%))"><small>今日推荐</small><b>${esc(x.n)}</b><span>${esc(x.s)}</span><div class="as-sf">${asIcon(x)}<em>${esc(x.n)}</em><button class="mip-get" data-a="get">获取</button></div></div>`;
      let top = '', body = '';
      if (a.tab === 'home') {
        top = `<div class="as-top"><button class="mip-back" data-a="back">${CHEV}</button><input class="mip-search" id="asq" placeholder="游戏、App 及更多内容" value="${esc(a.q)}"></div>`;
        const feat = AS_FEAT.map(n => AS_APPS.find(x => x.n === n)).filter(Boolean);
        if (q) { const list = AS_APPS.filter(x => (x.n + x.s + x.c).toLowerCase().includes(q)); body = `<div class="mip-sec">搜索结果</div><div class="mip-group">${list.length ? list.map(x => row(x)).join('') : '<div class="mip-empty">没有找到相关内容</div>'}</div>`; }
        else body = `<div class="as-car" id="ascar">${feat.map(slide).join('')}</div><div class="as-dots" id="asdots">${feat.map(() => '<i></i>').join('')}</div><div class="mip-sec">热门应用</div><div class="mip-group">${AS_APPS.filter(x => !x.fx).slice(0, 8).map(x => row(x)).join('')}</div>`;
      } else if (a.tab === 'rank') {
        top = '<h1 class="mip-h1 as-h">排行榜</h1>';
        body = `<div class="mip-group">${AS_APPS.map((x, i) => row(x, i + 1)).join('')}</div>`;
      } else if (a.tab === 'cat') {
        top = '<h1 class="mip-h1 as-h">分类</h1>';
        body = a.cat
          ? `<div class="mip-sec"><button class="mip-txt" data-a="ascat" data-c="">‹ 全部分类</button><span>${esc(a.cat)}</span></div><div class="mip-group">${AS_APPS.filter(x => x.c === a.cat).map(x => row(x)).join('') || '<div class="mip-empty">这个分类暂时没有应用</div>'}</div>`
          : `<div class="mip-cats">${AS_CATS.map(([n, c]) => `<div class="cat" data-a="ascat" data-c="${n}"><i style="background:${c}"></i>${n}</div>`).join('')}</div>`;
      } else {
        const nm = X().name1 || '我';
        top = '<h1 class="mip-h1 as-h">我的</h1>';
        body = `<div class="mip-group"><div class="mip-row"><div class="mip-av" style="width:54px;height:54px;font-size:22px;background:linear-gradient(160deg,#4aa3ff,#0a6cff)"><span>${esc([...nm][0])}</span></div><span><b>${esc(nm)}</b><small>My iPhone ID</small></span></div></div>
        <div class="mip-sec"></div><div class="mip-group">${['收藏', '已购项目', '订阅', '通知', '家人共享'].map(t => `<div class="mip-row tap" data-a="soon"><span>${t}</span><b class="chev">›</b></div>`).join('')}</div>`;
      }
      const tabs = [['home', '首页'], ['rank', '排行榜'], ['cat', '分类'], ['me', '我的']].map(([k, n]) => `<button data-a="astab" data-k="${k}" class="${a.tab === k ? 'on' : ''}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${TABI[k]}</svg><span>${n}</span></button>`).join('');
      const back = a.tab === 'home' ? '' : `<button class="as-back" data-a="back">${CHEV}<span>主屏幕</span></button>`;
      return `<div class="as-wrap">${back}${top}<div class="mip-scroll">${body}</div><div class="as-tabs">${tabs}</div></div>`;
    },
    mount(el) {
      clearInterval(asTimer); asTimer = null;
      const i = el.querySelector('#asq');
      if (i) {
        const apply = () => { S.as.q = i.value; const pos = i.selectionStart; render(); const n = $('#asq'); n.focus(); n.setSelectionRange(pos, pos); };
        i.addEventListener('input', e => { if (!e.isComposing) apply(); });
        i.addEventListener('compositionend', apply);
      }
      const car = el.querySelector('#ascar'); if (!car) return;
      const dots = [...el.querySelectorAll('#asdots i')], n = dots.length;
      const idx = () => Math.round(car.scrollLeft / car.clientWidth);
      const mark = () => { const k = idx(); dots.forEach((d, j) => d.classList.toggle('on', j === k)); };
      const start = () => { clearInterval(asTimer); asTimer = setInterval(() => car.scrollTo({ left: ((idx() + 1) % n) * car.clientWidth, behavior: 'smooth' }), 5000); };
      let raf = 0; car.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(mark); }, { passive: true });
      ['touchstart', 'pointerdown'].forEach(ev => car.addEventListener(ev, () => clearInterval(asTimer), { passive: true }));
      ['touchend', 'pointerup', 'pointercancel'].forEach(ev => car.addEventListener(ev, start, { passive: true }));
      mark(); start();
    },
    unmount() { clearInterval(asTimer); asTimer = null; },
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
      <div class="mip-foot" id="testres"></div>
      <div class="mip-sec">通用</div><div class="mip-group"><label class="mip-row"><span>向 AI 注入钱包提示<small>让剧情知道你的余额并输出记账标记</small></span><input type="checkbox" class="mip-sw" data-g="inject" ${g.inject ? 'checked' : ''}></label></div>
      <div class="mip-sec">银行时间</div><div class="mip-group"><label class="mip-row"><span>根据正文时间推进<small>开启后，银行日期、利息与催收都跟随剧情里的日期</small></span><input type="checkbox" class="mip-sw" data-g="followStory" ${g.followStory ? 'checked' : ''}></label></div>
      <div class="mip-sec">每条 AI 回复推进${g.followStory ? '（已停用）' : ''}</div><div class="mip-seg${g.followStory ? ' off' : ''}">${SPEEDS.map(([n, l]) => `<button data-a="dspd" data-v="${n}" ${g.followStory ? 'disabled' : ''} class="${same(g.daySpeed, n) ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="mip-foot">关闭「根据正文时间推进」后，每条 AI 回复让银行日期推进所选时长，这是与正文无关的独立时间；开启后以剧情日期为准，上面的档位全部失效。</p>
      <div class="mip-sec">数据</div><div class="mip-group"><div class="mip-row tap dn" data-a="reset">重置当前角色卡的小手机数据</div></div>
      <p class="mip-foot">每个角色卡拥有独立的钱包、银行、FX 和联系人数据。</p></div>`;
    },
  },
  fx: {
    dark: true,
    render() {
      const t = S.fxTab, F = D().fx;
      const tabs = [['mkt', '行情'], ['port', '持仓'], ['log', '记录']].map(([k, n]) => `<button data-a="fxtab" data-k="${k}" class="${t === k ? 'on' : ''}">${n}</button>`).join('');
      let body = '', bar = '';
      if (t === 'mkt') {
        const pct = v => (v >= 1 ? '全仓' : Math.round(v * 100) + '%');
        body = `<div class="fx-sym">AURA</div><div class="fx-name">Aurora Technologies</div><div class="fx-price" id="fxp"></div><div class="fx-chg" id="fxc"></div><canvas id="fxcv"></canvas>
        <div class="fx-sec"><div class="fx-lab">杠杆<small>0X 为不加杠杆，倍数越高越容易爆仓</small></div><div class="fx-chips">${LEVS.map(v => `<button data-a="lev" data-v="${v}" class="${v === F.lev ? 'on' : ''}">${v}X</button>`).join('')}</div></div>
        <div class="fx-sec"><div class="fx-lab">买入档位<small>占 FX 账户现金</small></div><div class="fx-chips">${TIERS.map(v => `<button data-a="btier" data-v="${v}" class="${v === S.buyTier ? 'on' : ''}">${pct(v)}</button>`).join('')}</div></div>
        <div class="fx-sec"><div class="fx-lab">卖出档位<small>占当前持仓</small></div><div class="fx-chips">${TIERS.map(v => `<button data-a="stier" data-v="${v}" class="${v === S.sellTier ? 'on' : ''}">${pct(v)}</button>`).join('')}</div></div>
        <div class="fx-est" id="fxest"></div><div class="fx-mini" id="fxm"></div>`;
        bar = '<div class="fx-bar"><button class="buy" data-a="fxbuy">买入</button><button class="sell" data-a="fxsell">卖出</button></div>';
      } else if (t === 'port') body = `<div id="fxport">${portHtml()}</div>`;
      else {
        const lab = { BUY: '买入', SELL: '卖出', LIQ: '爆仓平仓' };
        body = `<div class="mip-group">${F.log.length ? F.log.slice(0, 80).map(x => `<div class="mip-row"><span><b class="${x.side === 'BUY' ? 'up' : 'dn'}">${lab[x.side] || x.side}</b> ${x.q} 股 @ ${fmt(x.px)}${x.lev > 1 ? ' · ' + x.lev + 'X' : ''}<small>${dt(x.t)} · 手续费 ${fmt(x.fee)}</small></span>${x.pl != null ? `<b class="${plCls(x.pl)}">${sgn(x.pl)}${x.pct != null ? `<small>${x.pct >= 0 ? '+' : ''}${x.pct}%</small>` : ''}</b>` : ''}</div>`).join('') : '<div class="mip-empty">还没有交易记录</div>'}</div>`;
      }
      return `<div class="mip-fxwrap"><div class="mip-nav fx"><button class="mip-back" data-a="back">${CHEV}<span>主屏幕</span></button><div class="mip-seg dk">${tabs}</div><span class="w"></span></div><div class="mip-scroll fxs">${body}</div>${bar}</div>`;
    },
    mount() { ensureFx(); paintFx(); clearTimeout(fxTimer); schedTick(); },
    unmount() { clearTimeout(fxTimer); fxTimer = null; save(); },
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
function renderKeep() { if (fxQuiet) return; if (S.open && S.app !== 'chat' && S.app !== 'settings') render(); else if (S.open && S.app === 'chat') paintMsgs(S.busy); }
function go(app, p = {}) { unmountCur(); S.stack.push([S.app, S.p]); S.app = app; S.p = p; render(true); }
function back() { unmountCur(); const pv = S.stack.pop(); if (pv) [S.app, S.p] = pv; else { S.app = 'home'; S.p = {}; } render(true); }
function toHome() { unmountCur(); S.stack = []; S.app = 'home'; S.p = {}; render(true); }

const setOn = el => el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
const A = {
  open: el => { if (el.dataset.app === 'fx') S.fxTab = 'mkt'; go(el.dataset.app); },
  back: () => back(),
  homebar: () => (S.app === 'home' ? closePhone() : toHome()),
  adjust: () => modal({ title: '手动调整余额', msg: '正数增加，负数减少', input: { ph: '例如 500 或 -200' }, onOk(el) { const v = r2(parseFloat(el.querySelector('.mip-in').value)); if (!v) { toast('请输入金额'); return false; } if (addTx(v, '手动调整')) renderKeep(); else return false; } }),
  borrow: () => {
    const d = D(); if (d.black) return toast('账户已冻结，无法借款');
    const room = LOAN_MAX - d.loan.principal; if (room <= 0) return toast('已达到贷款上限');
    askAmount('借款', `年利率 ${(APR * 100).toFixed(1)}%，最多还可借 ${fmt(room)}`, room, v => { d.loan.principal = r2(d.loan.principal + v); addTx(v, '银行放款'); toast('已到账 ' + fmt(v)); });
  },
  repay: () => {
    const d = D(); if (d.black) return toast('账户已冻结，请用新收入抵扣欠款');
    const debt = totalDebt(), max = Math.min(debt, d.balance);
    if (debt <= 0) return toast('当前没有贷款'); if (max <= 0) return toast('存款余额不足');
    askAmount('还款', `待还 ${fmt(debt)}，先还利息再还本金`, max, v => {
      if (!addTx(-v, '偿还贷款')) return;
      const L = d.loan, i = Math.min(v, L.accrued); L.accrued = r2(L.accrued - i); L.principal = r2(Math.max(0, L.principal - (v - i)));
      if (d.col && L.accrued < COL_CLEAR) { d.col = null; bankSms('已确认您的还款，利息已降至规定线以下，催收解除。', true); }
      toast('已还款 ' + fmt(v));
    });
  },
  tofx: () => { const d = D(); if (d.black) return toast('账户已冻结，无法转账'); if (d.balance <= 0) return toast('存款余额不足'); askAmount('转入 FX 账户', '资金将从存款转入证券账户', d.balance, v => { if (addTx(-v, '转入 FX 账户')) d.fx.cash = r2(d.fx.cash + v); }); },
  fromfx: () => {
    const F = D().fx, mv = F.shares * F.price * KK, minCash = Math.max(0, F.margin - 0.95 * mv), max = r2(Math.max(0, F.cash - minCash));
    if (max <= 0) return toast(F.margin > 0 ? 'FX 资金被融资保证金占用' : 'FX 账户没有可转出的现金');
    askAmount('从 FX 转出', D().black ? '转出的资金会自动抵扣欠款' : '资金将转回存款', max, v => { F.cash = r2(F.cash - v); addTx(v, 'FX 转出'); });
  },
  astab: el => { S.as.tab = el.dataset.k; S.as.cat = ''; render(); },
  ascat: el => { S.as.cat = el.dataset.c || ''; render(); },
  soon: () => toast('功能即将开放'),
  get: () => toast('下载功能即将开放'),
  refc: () => refreshContacts(),
  csets: () => go('csets'),
  len: el => { G().replyLen = el.dataset.k; save(); render(); },
  av: el => pickAvatar(el.dataset.id),
  avrst: (el, e) => { e.stopPropagation(); const c = findContact(el.dataset.id); if (c) { c.avatar = ''; save(); render(); } },
  chat: el => go('chat', { id: el.dataset.id }),
  send: () => sendChat(),
  fxtab: el => { S.fxTab = el.dataset.k; render(); paintFx(); },
  lev: el => { D().fx.lev = Number(el.dataset.v); save(); setOn(el); paintFx(); },
  btier: el => { S.buyTier = Number(el.dataset.v); setOn(el); paintFx(); },
  stier: el => { S.sellTier = Number(el.dataset.v); setOn(el); paintFx(); },
  fxbuy: () => doBuy(),
  fxsell: () => doSell(),
  dspd: el => { G().daySpeed = Number(el.dataset.v); save(); render(); },
  test: async () => {
    const r = $('#testres'), put = (t, ok) => { if (r) { r.textContent = t; r.style.color = ok ? '#30a14e' : '#d93025'; } toast(t); };
    put('连接中…', true);
    try { const out = await ai([{ role: 'user', content: 'Reply with: ok' }], 16); put('连接成功' + (out ? '：' + out.slice(0, 24) : '（模型返回为空，但接口正常）'), true); }
    catch (e) { put('连接失败：' + e.message.slice(0, 120), false); }
  },
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
const isDesktop = () => matchMedia('(min-width:900px) and (hover:hover) and (pointer:fine)').matches;
function fitPhone() {
  const m = $('#mip-mask'); if (!m || isDesktop()) return;
  const h = (window.visualViewport?.height || innerHeight) + 'px';
  m.style.height = h;
}
function openPhone() {
  try {
    if (!$('#mip-mask')) S.open = false;
    if (S.open) return;
    S.open = true;
    const m = document.createElement('div'); m.id = 'mip-mask';
    m.innerHTML = `<div id="mip-phone" data-sb="l"><div class="mip-island"></div><div class="mip-status"><b id="mip-clock">${phoneClock()}</b><div>${statusIcons}</div></div><div id="mip-app"></div><div class="mip-hbar" data-a="homebar"><i></i></div></div>`;
    if (!isDesktop()) {
      m.style.cssText = 'position:fixed;left:0;top:0;width:100vw;z-index:2147483000;background:#000;overflow:hidden;';
      m.firstChild.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;width:100%;height:100%;border:0;border-radius:0;';
    }
    document.body.appendChild(m); fitPhone();
    const ph = $('#mip-phone');
    ph.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (el) A[el.dataset.a]?.(el, e); });
    ph.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'cin') { e.preventDefault(); sendChat(); } });
    const onField = e => {
      const k = e.target.dataset?.g; if (!k) return;
      const path = k.split('.'), g = G(), last = path.pop(); let o = g; path.forEach(p => { o = o[p]; });
      o[last] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
      save(); if (k === 'inject') refreshPrompt();
      if (k === 'followStory') { const d = D(); d.bankSt = d.story?.t ?? null; render(); }
    };
    ph.addEventListener('input', onField); ph.addEventListener('change', onField);
    window.addEventListener('resize', fitPhone); window.visualViewport?.addEventListener('resize', fitPhone);
    S.app = 'home'; S.stack = []; S.p = {}; render(true);
    clockT = setInterval(() => { const c = $('#mip-clock'); if (c) c.textContent = phoneClock(); }, 20000);
  } catch (e) {
    console.error('[My iPhone] open failed', e);
    $('#mip-mask')?.remove(); S.open = false;
    toast('小手机打开失败：' + (e?.message || e));
  }
}
function closePhone() {
  try { unmountCur(); } catch { /* ignore */ }
  clearInterval(clockT); window.removeEventListener('resize', fitPhone); window.visualViewport?.removeEventListener('resize', fitPhone);
  $('#mip-mask')?.remove(); S.open = false; save();
}
function mountFab() {
  const f = document.createElement('div'); f.id = 'mip-fab';
  f.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="6" y="2" width="12" height="20" rx="3" fill="none" stroke="#fff" stroke-width="1.8"/><rect x="10" y="4" width="4" height="1.4" rx=".7" fill="#fff"/></svg>`;
  document.body.appendChild(f);
  const clamp = (x, y) => [Math.max(4, Math.min(innerWidth - 52, x)), Math.max(4, Math.min(innerHeight - 52, y))];
  const pos = G().fab || [innerWidth - 60, innerHeight * 0.55];
  [f.style.left, f.style.top] = clamp(...pos).map(v => v + 'px');
  let sx = null, sy, ox, oy, moved = false;
  f.addEventListener('pointerdown', e => { try { f.setPointerCapture(e.pointerId); } catch { /* ignore */ } sx = e.clientX; sy = e.clientY; ox = f.offsetLeft; oy = f.offsetTop; moved = false; });
  f.addEventListener('pointermove', e => {
    if (sx == null) return;
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 6) moved = true;
    if (moved) { const [x, y] = clamp(ox + e.clientX - sx, oy + e.clientY - sy); f.style.left = x + 'px'; f.style.top = y + 'px'; }
  });
  f.addEventListener('pointerup', () => {
    if (sx == null) return; sx = null;
    if (moved) { G().fab = [f.offsetLeft, f.offsetTop]; save(); } else (S.open ? closePhone() : openPhone());
  });
  f.addEventListener('pointercancel', () => { sx = null; });
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

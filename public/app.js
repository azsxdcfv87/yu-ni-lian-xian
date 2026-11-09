// 與你連線 — 前端（無框架、免編譯）
const $ = (sel, root = document) => root.querySelector(sel);
const appEl = $('#app');
const TOKEN_KEY = 'yuni.token';

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// LINE／FB／IG 的內建瀏覽器收不到推播，也不能加入主畫面
const ua = navigator.userAgent;
const inAppBrowser = /\bLine\//i.test(ua) ? 'LINE'
  : /FBAN|FBAV|FB_IAB/i.test(ua) ? 'Facebook'
  : /Instagram/i.test(ua) ? 'Instagram'
  : /MicroMessenger/i.test(ua) ? '微信' : null;
// LINE 支援 openExternalBrowser=1：自動改用手機的預設瀏覽器（Chrome／Safari）開啟
if (inAppBrowser === 'LINE' && !new URLSearchParams(location.search).has('openExternalBrowser')) {
  const url = new URL(location.href);
  url.searchParams.set('openExternalBrowser', '1');
  location.replace(url.href);
}
const realBrowser = isIOS ? 'Safari' : 'Chrome';

// localStorage 在私密模式等情況可能丟錯，一律包起來
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無法儲存 */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* 無法儲存 */ } },
};

const state = {
  token: storage.get(TOKEN_KEY),
  data: null,
  screen: null,          // 目前畫面
  step: 'start',         // 歡迎流程：start | create | join | restore
  skipInstall: false,
  subscribed: false,
  draft: '',
  options: { notify: true, pinNotification: false, pinHome: true },
  widgetTemplate: null,
  showToken: false,
};

// ---------- 工具 ----------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    logout();
    throw new Error('登入已失效，請重新開始');
  }
  if (!res.ok) throw new Error(json.error || `連線失敗（${res.status}）`);
  return json;
}

async function withBusy(button, fn) {
  if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = '處理中…'; }
  try { await fn(); } catch (err) { toast(err.message || '發生錯誤'); } finally {
    if (button && button.isConnected) { button.disabled = false; button.textContent = button.dataset.label; }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------- 日期 ----------
const DAY = 86400000;
function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function todayLocal() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
function todayISO() {
  const t = todayLocal();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
const diffDays = (a, b) => Math.round((b - a) / DAY); // 用 round 避開日光節約時間誤差
function daysTogether(startDate) {
  return diffDays(parseLocalDate(startDate), todayLocal()) + 1; // 交往當天算第 1 天
}
function milestones(startDate) {
  const start = parseLocalDate(startDate);
  const today = todayLocal();
  const days = daysTogether(startDate);
  const nextHundred = Math.max(100, Math.ceil(days / 100) * 100);
  let years = today.getFullYear() - start.getFullYear();
  let anniv = new Date(start.getFullYear() + years, start.getMonth(), start.getDate());
  if (anniv < today) { years += 1; anniv = new Date(start.getFullYear() + years, start.getMonth(), start.getDate()); }
  return {
    hundred: { n: nextHundred, inDays: nextHundred - days },
    anniversary: { years, inDays: diffDays(today, anniv) },
  };
}
function formatDate(s) {
  const d = parseLocalDate(s);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} 天前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- 推播 ----------
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

function diagnostics() {
  return {
    platform: isIOS ? 'iOS' : /android/i.test(ua) ? 'Android' : 'other',
    inAppBrowser,
    standalone: isStandalone,
    pushSupported,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

// 把手機上的錯誤回報到伺服器終端機，方便除錯
function report(message) {
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: JSON.stringify({ message: String(message).slice(0, 500), ...diagnostics() }),
    }).catch(() => {});
  } catch { /* 忽略 */ }
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await withTimeout(navigator.serviceWorker.ready, 5000, 'Service Worker 沒有啟動');
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  if (inAppBrowser) {
    report('enablePush: in-app browser');
    toast(`${inAppBrowser} 內建瀏覽器收不到通知，請改用 ${realBrowser} 打開`);
    return;
  }
  if (!pushSupported) {
    report('enablePush: push unsupported');
    toast(isIOS && !isStandalone ? 'iPhone 要先「加入主畫面」，從桌面圖示打開才能開通知' : `這個瀏覽器不支援推播，請改用 ${realBrowser}`);
    return;
  }
  let step = '要求通知權限';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      report(`enablePush: permission ${permission}`);
      toast(permission === 'denied' ? '通知被封鎖了，請到瀏覽器的網站設定把通知打開' : '沒有允許通知，再按一次「開啟」試試');
      updateHome();
      return;
    }
    step = '啟動 Service Worker';
    const reg = await withTimeout(navigator.serviceWorker.ready, 10000, 'Service Worker 沒有啟動');
    step = '取得推播金鑰';
    const { key } = await api('/api/vapid-public-key');
    const options = { userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) };
    step = '向推播服務訂閱';
    let sub;
    try {
      sub = await reg.pushManager.subscribe(options);
    } catch (first) {
      // 可能是舊訂閱用的是別組金鑰：退訂後重來
      const old = await reg.pushManager.getSubscription();
      if (!old) throw first;
      await old.unsubscribe();
      sub = await reg.pushManager.subscribe(options);
    }
    step = '儲存到伺服器';
    await api('/api/subscriptions', { method: 'POST', body: sub.toJSON() });
    state.subscribed = true;
    step = '傳送測試通知';
    const result = await api('/api/test-push', { method: 'POST' });
    await refresh();
    toast(result.sent ? '通知已開啟 🔔 馬上會收到一則測試通知' : '已開啟，但測試通知送不出去');
  } catch (err) {
    report(`enablePush failed at ${step}: ${err.name}: ${err.message}`);
    throw new Error(`開啟通知失敗（${step}）：${err.message}`);
  }
}

// 本機有訂閱、但伺服器那邊沒有（例如被清掉）→ 自動補登
async function syncSubscription() {
  try {
    const sub = await currentSubscription();
    state.subscribed = Boolean(sub) && Notification.permission === 'granted';
    if (state.subscribed && state.data && state.data.me.pushDevices === 0) {
      await api('/api/subscriptions', { method: 'POST', body: sub.toJSON() });
      state.data.me.pushDevices = 1;
    }
  } catch { /* 忽略 */ }
}

// ---------- 資料 ----------
async function refresh() {
  if (!state.token) return;
  try {
    state.data = await api('/api/me');
    render();
  } catch (err) {
    if (state.token) console.warn(err);
  }
}

function saveSession(json) {
  if (json.token) { state.token = json.token; storage.set(TOKEN_KEY, json.token); }
  state.data = json;
}

function logout() {
  state.token = null;
  state.data = null;
  state.step = 'start';
  storage.remove(TOKEN_KEY);
  render();
}

async function ensureUser(name) {
  if (state.token) return;
  saveSession(await api('/api/users', { method: 'POST', body: { name } }));
}

// ---------- 畫面 ----------
function screenKey() {
  if (state.screen === 'settings' && state.data?.couple?.paired) return 'settings';
  if (!state.token || !state.data) {
    return isIOS && !isStandalone && !state.skipInstall ? 'install' : `welcome-${state.step}`;
  }
  if (!state.data.couple) return `welcome-${state.step === 'start' ? 'choose' : state.step}`;
  if (!state.data.couple.paired) return state.step === 'join' ? 'welcome-join' : 'waiting';
  return 'home';
}

function render() {
  const key = screenKey();
  if (key === 'home' && state.screen === 'home') { updateHome(); return; }
  state.screen = key;
  if (key === 'install') renderInstall();
  else if (key.startsWith('welcome-')) renderWelcome(key.slice(8));
  else if (key === 'waiting') renderWaiting();
  else if (key === 'settings') renderSettings();
  else renderHome();
  window.scrollTo(0, 0);
}

const brand = `
  <div class="brand">
    <img src="/icons/icon-192.png" alt="" width="72" height="72">
    <h1>與你連線</h1>
    <p>兩個人的專屬小空間</p>
  </div>`;

function renderInstall() {
  appEl.innerHTML = `
    <section class="screen center">
      ${brand}
      <div class="card">
        <h2>先把我加到主畫面 📲</h2>
        <p class="muted">iPhone 只有從主畫面打開，才能收到對方的通知。而且主畫面的 App 和 Safari 的資料是分開的，所以請直接在主畫面的 App 裡註冊。</p>
        <ol class="steps">
          <li>點 Safari 下方的「分享」按鈕 <span class="kbd">⬆︎</span></li>
          <li>往下滑，選「加入主畫面」</li>
          <li>回到桌面，點「與你連線」圖示打開</li>
        </ol>
      </div>
      <button class="link" data-action="skip-install">先在瀏覽器看看</button>
    </section>`;
}

function renderWelcome(requested) {
  const hasUser = Boolean(state.token);
  const step = ['create', 'join', 'restore'].includes(requested) ? requested : 'start';
  let body = '';
  if (step === 'start') {
    body = `
      <form class="card" data-form="choose">
        ${hasUser ? `<p>嗨 ${esc(state.data?.me.name)}，接下來要：</p>` : `
          <label class="field">
            <span>你的暱稱</span>
            <input name="name" maxlength="20" autocomplete="nickname" placeholder="例如：胖胖" required>
          </label>`}
        <button class="primary" name="go" value="create">建立我們的空間</button>
        <button class="secondary" name="go" value="join">我有對方的配對碼</button>
      </form>
      ${hasUser ? '' : '<button class="link" data-action="step" data-step="restore">換手機了？用登入碼還原</button>'}`;
  } else if (step === 'create') {
    body = `
      <form class="card" data-form="create">
        <label class="field">
          <span>我們在一起的那天</span>
          <input type="date" name="startDate" max="${todayISO()}" required>
        </label>
        <button class="primary">建立並取得配對碼</button>
      </form>
      <button class="link" data-action="step" data-step="start">← 返回</button>`;
  } else if (step === 'join') {
    body = `
      <form class="card" data-form="join">
        <label class="field">
          <span>對方給你的 6 碼配對碼</span>
          <input name="code" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false" class="code-input" placeholder="ABC234" required>
        </label>
        <button class="primary">連線 💞</button>
      </form>
      <button class="link" data-action="step" data-step="${state.data?.couple ? 'waiting' : 'start'}">← 返回</button>`;
  } else if (step === 'restore') {
    body = `
      <form class="card" data-form="restore">
        <label class="field">
          <span>登入碼</span>
          <input name="token" autocomplete="off" spellcheck="false" placeholder="從舊裝置的「設定」複製" required>
        </label>
        <button class="primary">還原</button>
      </form>
      <button class="link" data-action="step" data-step="start">← 返回</button>`;
  }
  appEl.innerHTML = `<section class="screen center">${brand}${body}</section>`;
  appEl.querySelector('input')?.focus({ preventScroll: true });
}

function renderWaiting() {
  const { couple } = state.data;
  appEl.innerHTML = `
    <section class="screen center">
      ${brand}
      <div class="card">
        <p class="muted">把這組配對碼給對方，在他的「與你連線」輸入：</p>
        <div class="pair-code" aria-label="配對碼">${esc(couple.code)}</div>
        <div class="row">
          <button class="secondary" data-action="copy-code">複製</button>
          ${navigator.share ? '<button class="secondary" data-action="share-code">分享</button>' : ''}
        </div>
        <p class="waiting"><span class="pulse"></span>等待對方連線中…</p>
        <p class="muted small">交往日：${formatDate(couple.startDate)}</p>
      </div>
      <button class="link" data-action="step" data-step="join">其實是對方先建立的？改輸入配對碼</button>
    </section>`;
}

function renderHome() {
  const { partner } = state.data;
  appEl.innerHTML = `
    <header class="topbar">
      <h1>與你連線</h1>
      <button class="icon-btn" data-action="settings" aria-label="設定">⚙︎</button>
    </header>
    <section class="screen">
      <div id="hero"></div>
      <div id="banner"></div>
      <div id="pinned"></div>
      <form class="card compose" data-form="message">
        <h2>傳一句話給 <span id="partner-name">${esc(partner.name)}</span></h2>
        <textarea name="text" maxlength="200" rows="3" placeholder="今天想對你說…" required>${esc(state.draft)}</textarea>
        <div class="chips">
          ${['想你了 💭', '早安 ☀️', '晚安 🌙', '到家了嗎？', '愛你 ❤️', '加油！💪']
            .map((t) => `<button type="button" class="chip" data-action="chip" data-text="${esc(t)}">${esc(t)}</button>`).join('')}
        </div>
        <div class="options">
          ${toggle('notify', '傳送通知', '對方手機會跳出通知')}
          ${toggle('pinNotification', '釘在通知列', '通知不會自動收起，對方滑掉前都在（Android 最明顯）')}
          ${toggle('pinHome', '釘在對方首頁', '顯示在對方的 App 首頁和桌面小工具')}
        </div>
        <p id="partner-push" class="muted small"></p>
        <button class="primary">送出</button>
      </form>
      <div id="history"></div>
    </section>`;
  syncOptionInputs();
  updateHome();
}

function toggle(name, label, hint) {
  return `
    <label class="toggle">
      <input type="checkbox" name="${name}">
      <span class="switch" aria-hidden="true"></span>
      <span class="toggle-text"><strong>${label}</strong><small>${hint}</small></span>
    </label>`;
}

function syncOptionInputs() {
  const form = appEl.querySelector('[data-form="message"]');
  if (!form) return;
  for (const [k, v] of Object.entries(state.options)) form.elements[k].checked = v;
  form.elements.pinNotification.disabled = !state.options.notify;
}

function updateHome() {
  if (state.screen !== 'home' || !state.data?.couple) return;
  const { me, partner, couple, pinned, partnerPinned, messages } = state.data;
  const days = daysTogether(couple.startDate);
  const ms = milestones(couple.startDate);
  const special = ms.hundred.inDays === 0 ? `🎉 今天是第 ${ms.hundred.n} 天！`
    : ms.anniversary.inDays === 0 ? `🎉 今天是 ${ms.anniversary.years} 週年！` : '';

  $('#hero').innerHTML = `
    <div class="hero">
      <p class="names">${esc(me.name)} <span class="heart">♥</span> ${esc(partner.name)}</p>
      <p class="label">我們在一起</p>
      <p class="days"><span>${days.toLocaleString()}</span> 天</p>
      <p class="since">從 ${formatDate(couple.startDate)} 開始</p>
      ${special ? `<p class="special">${special}</p>` : `
      <div class="milestones">
        <span>第 ${ms.hundred.n} 天 · 還有 ${ms.hundred.inDays} 天</span>
        <span>${ms.anniversary.years} 週年 · 還有 ${ms.anniversary.inDays} 天</span>
      </div>`}
    </div>`;

  $('#banner').innerHTML = pushBanner();

  $('#pinned').innerHTML = pinned ? `
    <div class="card pinned">
      <div class="pinned-head"><span>📌 釘選的話</span><button class="link small" data-action="unpin">取消釘選</button></div>
      <blockquote>${esc(pinned.text)}</blockquote>
      <p class="muted small">— ${esc(pinned.fromName)} · ${timeAgo(pinned.createdAt)}</p>
    </div>` : `
    <div class="card pinned empty">
      <p>📌 還沒有釘選的話</p>
      <p class="muted small">對方傳來的話可以釘在這裡，也會顯示在桌面小工具上</p>
    </div>`;

  $('#partner-name').textContent = partner.name;
  $('#partner-push').textContent = partner.pushDevices
    ? (partnerPinned ? `${partner.name} 的首頁現在釘著：「${partnerPinned.text}」` : '')
    : `${partner.name} 還沒開啟通知，訊息會先放在 App 裡`;

  const list = [...messages].reverse().slice(0, 30);
  $('#history').innerHTML = `
    <h2 class="section-title">最近的話</h2>
    ${list.length ? `<ul class="messages">${list.map((m) => `
      <li class="msg ${m.from === me.id ? 'mine' : 'theirs'}">
        <div class="bubble">${esc(m.text)}</div>
        <div class="meta">
          <span>${m.from === me.id ? '我' : esc(m.fromName)} · ${timeAgo(m.createdAt)}</span>
          ${pinned?.id === m.id ? '<span class="pinned-tag">已釘選</span>'
            : `<button class="link small" data-action="pin" data-id="${esc(m.id)}">釘到我的首頁</button>`}
        </div>
      </li>`).join('')}</ul>` : '<p class="muted center-text">還沒有訊息，傳第一句話吧 💌</p>'}`;
}

function pushBanner() {
  if (state.subscribed && state.data.me.pushDevices > 0) return '';
  if (inAppBrowser) {
    return `<div class="banner">你正在用 ${inAppBrowser} 的內建瀏覽器，收不到通知。請點右上角「⋯」選單，選「用 ${realBrowser} 開啟」。</div>`;
  }
  if (isIOS && !isStandalone) {
    return `<div class="banner">iPhone 要先「分享 → 加入主畫面」，從桌面圖示打開才能收到通知。</div>`;
  }
  if (!pushSupported) return '<div class="banner">這個瀏覽器不支援推播通知，請改用 Chrome 或從主畫面打開。</div>';
  if (Notification.permission === 'denied') {
    return '<div class="banner">通知權限被關掉了，請到手機的「設定 → 通知」把「與你連線」打開。</div>';
  }
  return `
    <div class="banner action">
      <span>開啟通知，才收得到對方傳的話 🔔</span>
      <button class="primary small" data-action="enable-push">開啟</button>
    </div>`;
}

async function renderSettings() {
  const { me, couple } = state.data;
  appEl.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-action="back" aria-label="返回">←</button>
      <h1>設定</h1>
      <span class="icon-btn" aria-hidden="true"></span>
    </header>
    <section class="screen">
      <form class="card" data-form="name">
        <label class="field"><span>我的暱稱</span>
          <input name="name" maxlength="20" value="${esc(me.name)}" required></label>
        <button class="secondary">儲存暱稱</button>
      </form>
      <form class="card" data-form="date">
        <label class="field"><span>交往紀念日</span>
          <input type="date" name="startDate" max="${todayISO()}" value="${esc(couple.startDate)}" required></label>
        <button class="secondary">儲存日期</button>
      </form>
      <div class="card">
        <h2>通知</h2>
        <p class="muted">${state.subscribed ? '這台裝置已開啟通知 ✅' : '這台裝置還沒開啟通知'}</p>
        <div class="row">
          ${state.subscribed ? '<button class="secondary" data-action="test-push">傳一則測試通知給自己</button>'
            : '<button class="primary" data-action="enable-push">開啟通知</button>'}
        </div>
        <h3 class="diag-title">通知診斷（收不到通知時截圖給我）</h3>
        <ul class="diag" id="diag"><li><span>檢查中…</span></li></ul>
      </div>
      <div class="card">
        <h2>iPhone 桌面小工具</h2>
        <p class="muted">用免費的 <strong>Scriptable</strong> App，在桌面顯示交往天數和釘選的話：</p>
        <ol class="steps">
          <li>App Store 下載「Scriptable」</li>
          <li>按下方按鈕複製程式碼</li>
          <li>打開 Scriptable → 右上「＋」→ 貼上 → 命名「與你連線」</li>
          <li>長按桌面 → 「＋」→ 選 Scriptable 小工具 → 編輯小工具 → Script 選「與你連線」</li>
        </ol>
        <button class="secondary" data-action="copy-widget" ${state.widgetTemplate ? '' : 'disabled'}>複製小工具程式碼</button>
        <p class="muted small">程式碼裡含有你的登入碼，不要傳給別人。網址變了（例如重開 tunnel）要重新複製。</p>
      </div>
      <div class="card">
        <h2>重新配對</h2>
        <p class="muted">對方換手機、刪掉 App，或 iPhone 從主畫面打開變成沒登入時使用。會產生新的配對碼，對方用新帳號輸入就能接回來，之前的訊息都會保留。</p>
        <button class="secondary" data-action="reinvite">產生新的配對碼</button>
      </div>
      <div class="card">
        <h2>登入碼</h2>
        <p class="muted">換手機或在另一台裝置登入時使用。等同密碼，請勿外流。</p>
        ${state.showToken ? `<code class="token">${esc(state.token)}</code>` : ''}
        <div class="row">
          <button class="secondary" data-action="toggle-token">${state.showToken ? '隱藏' : '顯示'}</button>
          <button class="secondary" data-action="copy-token">複製</button>
        </div>
      </div>
      <button class="danger" data-action="logout">登出這台裝置</button>
    </section>`;
  fillDiagnostics();
  if (!state.widgetTemplate) {
    try {
      state.widgetTemplate = await (await fetch('/widget-template.js')).text();
      const btn = appEl.querySelector('[data-action="copy-widget"]');
      if (btn) btn.disabled = false;
    } catch { /* 離線 */ }
  }
}

// ---------- 事件 ----------
appEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const button = event.submitter || form.querySelector('button:not([type="button"])');
  const v = (name) => form.elements[name]?.value.trim();

  const handlers = {
    choose: async () => {
      const go = event.submitter?.value || 'create';
      if (!state.token) await ensureUser(v('name'));
      state.step = go;
      render();
    },
    create: async () => {
      saveSession(await api('/api/couples', { method: 'POST', body: { startDate: v('startDate') } }));
      state.step = 'waiting';
      render();
    },
    join: async () => {
      saveSession(await api('/api/couples/join', { method: 'POST', body: { code: v('code') } }));
      state.step = 'start';
      render();
      toast(`已經和 ${state.data.partner.name} 連線了 💞`);
    },
    restore: async () => {
      state.token = v('token');
      try {
        state.data = await api('/api/me');
        storage.set(TOKEN_KEY, state.token);
        render();
        toast('還原成功');
      } catch (err) {
        state.token = null;
        throw err;
      }
    },
    message: async () => {
      const text = v('text');
      const res = await api('/api/messages', { method: 'POST', body: { text, ...state.options } });
      state.data = res;
      state.draft = '';
      form.elements.text.value = '';
      updateHome();
      const where = [res.push.sent ? '已送出通知' : '', state.options.pinHome ? '已釘在對方首頁' : ''].filter(Boolean).join('、');
      toast(where ? `${where} 💌` : '已送出 💌');
    },
    name: async () => {
      state.data = await api('/api/me', { method: 'PATCH', body: { name: v('name') } });
      toast('暱稱已更新');
    },
    date: async () => {
      state.data = await api('/api/couples', { method: 'PATCH', body: { startDate: v('startDate') } });
      toast('紀念日已更新');
    },
  };
  const handler = handlers[form.dataset.form];
  if (handler) withBusy(button, handler);
});

appEl.addEventListener('input', (event) => {
  const el = event.target;
  if (el.name === 'text') state.draft = el.value;
  if (el.name === 'code') el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

appEl.addEventListener('change', (event) => {
  const el = event.target;
  if (el.type === 'checkbox' && el.name in state.options) {
    state.options[el.name] = el.checked;
    if (el.name === 'notify' && !el.checked) state.options.pinNotification = false;
    syncOptionInputs();
  }
});

appEl.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const actions = {
    'skip-install': () => { state.skipInstall = true; render(); },
    step: () => { state.step = el.dataset.step; render(); },
    'copy-code': async () => { await copyText(state.data.couple.code); toast('已複製配對碼'); },
    'share-code': () => navigator.share({ title: '與你連線', text: `跟我連線吧 💞 配對碼：${state.data.couple.code}`, url: location.origin }).catch(() => {}),
    chip: () => {
      const ta = appEl.querySelector('textarea[name="text"]');
      ta.value = el.dataset.text;
      state.draft = ta.value;
      ta.focus();
    },
    'enable-push': () => withBusy(el, enablePush),
    'test-push': () => withBusy(el, async () => {
      const r = await api('/api/test-push', { method: 'POST' });
      toast(r.sent ? '測試通知已送出，看看通知列' : '送出失敗，請重新開啟通知');
    }),
    pin: () => withBusy(null, async () => {
      state.data = await api('/api/pin', { method: 'POST', body: { messageId: el.dataset.id } });
      updateHome();
      toast('已釘到首頁 📌');
    }),
    unpin: () => withBusy(null, async () => {
      state.data = await api('/api/pin', { method: 'POST', body: { messageId: null } });
      updateHome();
    }),
    settings: () => { state.screen = 'settings'; render(); },
    back: () => { state.screen = null; render(); },
    'copy-widget': async () => {
      const code = state.widgetTemplate.replace('__SERVER__', location.origin).replace('__TOKEN__', state.token);
      await copyText(code);
      toast('已複製，去 Scriptable 貼上吧');
    },
    'toggle-token': () => { state.showToken = !state.showToken; renderSettings(); },
    'copy-token': async () => { await copyText(state.token); toast('已複製登入碼'); },
    reinvite: () => {
      if (!confirm('要產生新的配對碼嗎？對方需要重新輸入才能連線，之前的訊息會保留。')) return;
      withBusy(el, async () => {
        state.data = await api('/api/couples/reinvite', { method: 'POST' });
        state.screen = null;
        state.step = 'waiting';
        render();
      });
    },
    logout: () => {
      if (confirm('確定要登出這台裝置嗎？之後可以用登入碼還原。')) { state.screen = null; logout(); }
    },
  };
  actions[el.dataset.action]?.();
});

async function fillDiagnostics() {
  const d = diagnostics();
  let sw = '沒有註冊 ❌';
  let sub = '沒有 ❌';
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) sw = reg.active ? '執行中 ✅' : '安裝中…';
    const s = await reg?.pushManager?.getSubscription();
    if (s) sub = `有 ✅（${new URL(s.endpoint).host}）`;
  } catch (err) {
    sw = `錯誤：${err.message}`;
  }
  const rows = [
    ['裝置', d.platform],
    ['開啟方式', d.inAppBrowser ? `${d.inAppBrowser} 內建瀏覽器 ❌` : d.standalone ? '主畫面 App ✅' : `瀏覽器分頁${isIOS ? ' ❌（要從主畫面開）' : ''}`],
    ['支援推播', d.pushSupported ? '是 ✅' : '否 ❌'],
    ['通知權限', { granted: '已允許 ✅', denied: '已封鎖 ❌', default: '還沒允許', unsupported: '不支援 ❌' }[d.permission]],
    ['Service Worker', sw],
    ['這台的推播訂閱', sub],
    ['伺服器記錄的裝置', `${state.data?.me.pushDevices ?? 0} 台`],
  ];
  const el = $('#diag');
  if (el) el.innerHTML = rows.map(([k, v]) => `<li><span>${esc(k)}</span><strong>${esc(v)}</strong></li>`).join('');
}

// ---------- 啟動 ----------
addEventListener('error', (e) => report(`JS error: ${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => report(`Unhandled: ${e.reason?.message || e.reason}`));

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => report(`SW 註冊失敗: ${err.message}`));
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'refresh') refresh(); });
  }
  navigator.clearAppBadge?.().catch(() => {});

  if (state.token) {
    try {
      state.data = await api('/api/me');
    } catch (err) {
      if (state.token) toast('連不上伺服器，稍後再試');
    }
  }
  await syncSubscription();
  render();
  report(`opened (${state.data?.me.pushDevices ?? 0} push devices on server, local subscribed=${state.subscribed})`);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      navigator.clearAppBadge?.().catch(() => {});
      refresh();
    }
  });
  // 等待配對時每 3 秒檢查一次；配對後每 20 秒同步一次
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !state.token) return;
    if (state.screen === 'waiting') refresh();
  }, 3000);
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.screen === 'home') refresh();
  }, 20000);
}

boot();

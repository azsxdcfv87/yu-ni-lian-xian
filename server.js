// 與你連線 — 後端：配對、訊息、釘選、Web Push
// 資料存在 Firestore（有 Firebase 金鑰時）或 data/ 資料夾（本機開發），見 storage.js
import express from 'express';
import webpush from 'web-push';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const storage = await createStorage({ dataDir: DATA_DIR });

// ---------- VAPID 金鑰（第一次啟動自動產生，存在儲存層裡） ----------
async function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const saved = await storage.loadVapid();
  if (saved) return saved;
  const keys = webpush.generateVAPIDKeys();
  await storage.saveVapid(keys);
  console.log('已產生新的 VAPID 推播金鑰');
  return keys;
}
const vapid = await loadVapidKeys();
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'https://github.com/azsxdcfv87/yu-ni-lian-xian',
  vapid.publicKey,
  vapid.privateKey,
);

// ---------- 資料 ----------
const db = await storage.load();
const tokenIndex = new Map(Object.values(db.users).map((u) => [u.token, u.id]));

// 寫入排隊依序執行；連續多次 save() 只會真的寫最後一次的狀態
let saving = Promise.resolve();
let dirty = false;
function save() {
  dirty = true;
  saving = saving.catch(() => {}).then(async () => {
    if (!dirty) return;
    dirty = false;
    try {
      await storage.save(db);
    } catch (err) {
      dirty = true; // 下次 save() 會再試
      console.error('❌ 儲存失敗', err);
      throw err;
    }
  });
  return saving;
}

const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0/O/1/I
function newPairCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!Object.values(db.couples).some((c) => c.code === code)) return code;
  }
}

// ---------- 驗證工具 ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function cleanText(value, max, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new HttpError(400, `請填寫${field}`);
  if ([...text].length > max) throw new HttpError(400, `${field}最多 ${max} 個字`);
  return text;
}
function cleanDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, '日期格式不正確');
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new HttpError(400, '日期不存在');
  }
  if (date.getTime() > Date.now() + 86400000) throw new HttpError(400, '交往日不能在未來');
  return value;
}

// ---------- 查詢工具 ----------
const coupleOf = (user) => (user.coupleId ? db.couples[user.coupleId] : null);
function partnerOf(user) {
  const couple = coupleOf(user);
  const partnerId = couple?.members.find((m) => m !== user.id);
  return partnerId ? db.users[partnerId] : null;
}
function findMessage(coupleId, messageId) {
  return (db.messages[coupleId] || []).find((m) => m.id === messageId) || null;
}
function messageView(msg) {
  if (!msg) return null;
  return { id: msg.id, from: msg.from, fromName: db.users[msg.from]?.name ?? '', text: msg.text, createdAt: msg.createdAt };
}
function meView(user) {
  const couple = coupleOf(user);
  const partner = partnerOf(user);
  return {
    me: { id: user.id, name: user.name, pushDevices: (user.subscriptions || []).length },
    couple: couple && {
      startDate: couple.startDate,
      paired: couple.members.length === 2,
      code: couple.members.length < 2 ? couple.code : null,
    },
    partner: partner && { id: partner.id, name: partner.name, pushDevices: (partner.subscriptions || []).length },
    pinned: couple ? messageView(findMessage(couple.id, user.pinnedMessageId)) : null,
    partnerPinned: couple && partner ? messageView(findMessage(couple.id, partner.pinnedMessageId)) : null,
    messages: couple ? (db.messages[couple.id] || []).slice(-50).map(messageView) : [],
  };
}

// ---------- 推播 ----------
async function pushTo(user, payload) {
  const subs = user.subscriptions || [];
  if (!subs.length) {
    console.log(`📭 ${user.name} 還沒開啟通知，略過推播`);
    return { sent: 0, failed: 0 };
  }
  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'high' })),
  );
  let sent = 0;
  let failed = 0;
  const gone = new Set();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { sent++; return; }
    failed++;
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) gone.add(subs[i].endpoint); // 訂閱已失效
    else console.warn('推播失敗', code, r.reason?.body || r.reason?.message);
  });
  if (gone.size) {
    user.subscriptions = subs.filter((s) => !gone.has(s.endpoint));
    await save();
  }
  console.log(`📨 推播 → ${user.name}：成功 ${sent}、失敗 ${failed}${gone.size ? `（清掉 ${gone.size} 個失效訂閱）` : ''}`);
  return { sent, failed };
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// 健康檢查：Render 用來確認服務活著，防休眠排程也打這裡
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, storage: storage.kind.split('（')[0], users: Object.keys(db.users).length, uptime: Math.round(process.uptime()) });
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
function auth(req, _res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const userId = tokenIndex.get(token);
  if (!userId || !db.users[userId]) return next(new HttpError(401, '登入已失效'));
  req.user = db.users[userId];
  next();
}
function requirePaired(req) {
  const couple = coupleOf(req.user);
  const partner = partnerOf(req.user);
  if (!couple || !partner) throw new HttpError(409, '還沒完成配對');
  return { couple, partner };
}

app.get('/api/vapid-public-key', (_req, res) => res.json({ key: vapid.publicKey }));

// 建立使用者（這台裝置的身分）
app.post('/api/users', route(async (req, res) => {
  const name = cleanText(req.body.name, 20, '暱稱');
  const user = { id: randomId(9), token: randomId(24), name, coupleId: null, pinnedMessageId: null, subscriptions: [], createdAt: new Date().toISOString() };
  db.users[user.id] = user;
  tokenIndex.set(user.token, user.id);
  await save();
  res.status(201).json({ token: user.token, ...meView(user) });
}));

app.get('/api/me', auth, (req, res) => res.json(meView(req.user)));

app.patch('/api/me', auth, route(async (req, res) => {
  req.user.name = cleanText(req.body.name, 20, '暱稱');
  await save();
  res.json(meView(req.user));
}));

// 建立情侶空間，拿到配對碼
app.post('/api/couples', auth, route(async (req, res) => {
  if (coupleOf(req.user)?.members.length === 2) throw new HttpError(409, '你已經配對過了');
  const startDate = cleanDate(req.body.startDate);
  const existing = coupleOf(req.user);
  if (existing) { // 還在等待中的空間：更新日期即可
    existing.startDate = startDate;
  } else {
    const couple = { id: randomId(9), code: newPairCode(), startDate, members: [req.user.id], createdAt: new Date().toISOString() };
    db.couples[couple.id] = couple;
    req.user.coupleId = couple.id;
  }
  await save();
  res.status(201).json(meView(req.user));
}));

// 輸入配對碼加入
app.post('/api/couples/join', auth, route(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s/g, '');
  const couple = Object.values(db.couples).find((c) => c.code === code);
  if (!couple) throw new HttpError(404, '找不到這個配對碼');
  if (couple.members.includes(req.user.id)) throw new HttpError(400, '這是你自己的配對碼喔');
  if (couple.members.length >= 2) {
    throw new HttpError(409, '這個配對碼已經被使用了。如果是換手機或重裝，請對方到「設定 → 重新配對」產生新的配對碼');
  }
  const mine = coupleOf(req.user);
  if (mine?.members.length === 2) throw new HttpError(409, '你已經配對過了');
  if (mine) delete db.couples[mine.id]; // 丟掉自己還在等待的空間
  couple.members.push(req.user.id);
  req.user.coupleId = couple.id;
  db.messages[couple.id] ||= [];
  inheritFormerMember(couple, req.user);
  await save();
  const partner = partnerOf(req.user);
  console.log(`💞 ${req.user.name} 和 ${partner?.name} 連線了`);
  pushTo(partner, { title: '與你連線 💞', body: `${req.user.name} 已經和你連線了！`, tag: 'paired', url: '/' }).catch(() => {});
  res.json(meView(req.user));
}));

// 重新配對：對方換手機、刪掉 App 或 iPhone 資料不見時，產生新的配對碼重新邀請
app.post('/api/couples/reinvite', auth, route(async (req, res) => {
  const couple = coupleOf(req.user);
  if (!couple) throw new HttpError(409, '還沒有情侶空間');
  const partner = partnerOf(req.user);
  if (partner) {
    partner.coupleId = null;
    couple.formerMember = partner.id; // 對方用新帳號加入時，把舊訊息轉給新帳號
  }
  couple.members = [req.user.id];
  couple.code = newPairCode();
  await save();
  console.log(`🔁 ${req.user.name} 產生新的配對碼 ${couple.code}${partner ? `（${partner.name} 先移出，訊息保留）` : ''}`);
  res.json(meView(req.user));
}));

// 新帳號接手被移出的舊帳號：訊息、釘選都轉過來，舊帳號刪除
function inheritFormerMember(couple, joiner) {
  const formerId = couple.formerMember;
  delete couple.formerMember;
  if (!formerId || formerId === joiner.id) return;
  const former = db.users[formerId];
  for (const msg of db.messages[couple.id] || []) if (msg.from === formerId) msg.from = joiner.id;
  if (former) {
    joiner.pinnedMessageId ??= former.pinnedMessageId;
    tokenIndex.delete(former.token);
    delete db.users[formerId];
  }
}

app.patch('/api/couples', auth, route(async (req, res) => {
  const couple = coupleOf(req.user);
  if (!couple) throw new HttpError(409, '還沒有情侶空間');
  couple.startDate = cleanDate(req.body.startDate);
  await save();
  res.json(meView(req.user));
}));

// 推播訂閱
app.post('/api/subscriptions', auth, route(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) {
    throw new HttpError(400, '訂閱資料不正確');
  }
  const subs = (req.user.subscriptions ||= []).filter((s) => s.endpoint !== endpoint);
  subs.push({ endpoint, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) } });
  req.user.subscriptions = subs.slice(-5); // 每人最多 5 台裝置
  await save();
  console.log(`🔔 ${req.user.name} 開啟通知（${new URL(endpoint).host}），共 ${req.user.subscriptions.length} 台裝置`);
  res.status(201).json({ pushDevices: req.user.subscriptions.length });
}));

app.delete('/api/subscriptions', auth, route(async (req, res) => {
  const endpoint = req.body?.endpoint;
  req.user.subscriptions = (req.user.subscriptions || []).filter((s) => s.endpoint !== endpoint);
  await save();
  res.json({ pushDevices: req.user.subscriptions.length });
}));

app.post('/api/test-push', auth, route(async (req, res) => {
  const result = await pushTo(req.user, { title: '與你連線', body: '推播測試成功 🎉 之後對方傳的話會出現在這裡', tag: 'test', url: '/' });
  res.json(result);
}));

// 傳一句話給對方
//   notify            → 推播通知
//   pinNotification   → 用固定 tag + requireInteraction，留在通知列直到對方滑掉
//   pinHome           → 釘選在對方的 App 首頁和桌面小工具
app.post('/api/messages', auth, route(async (req, res) => {
  const { couple, partner } = requirePaired(req);
  const text = cleanText(req.body.text, 200, '想說的話');
  const notify = req.body.notify !== false;
  const pinNotification = notify && req.body.pinNotification === true;
  const pinHome = req.body.pinHome === true;

  const msg = { id: randomId(9), from: req.user.id, text, createdAt: new Date().toISOString() };
  const list = (db.messages[couple.id] ||= []);
  list.push(msg);
  if (list.length > 500) list.splice(0, list.length - 500);
  if (pinHome) partner.pinnedMessageId = msg.id;
  await save();

  let push = { sent: 0, failed: 0 };
  if (notify) {
    push = await pushTo(partner, {
      title: pinNotification ? `📌 ${req.user.name}` : `${req.user.name} 傳了一句話`,
      body: text,
      tag: pinNotification ? 'pinned' : `msg-${msg.id}`,
      requireInteraction: pinNotification,
      url: '/',
    });
  }
  res.status(201).json({ message: messageView(msg), push, ...meView(req.user) });
}));

// 釘選／取消釘選到自己的首頁
app.post('/api/pin', auth, route(async (req, res) => {
  const couple = coupleOf(req.user);
  if (!couple) throw new HttpError(409, '還沒有情侶空間');
  const { messageId } = req.body || {};
  if (messageId == null) {
    req.user.pinnedMessageId = null;
  } else {
    if (!findMessage(couple.id, messageId)) throw new HttpError(404, '找不到這則訊息');
    req.user.pinnedMessageId = messageId;
  }
  await save();
  res.json(meView(req.user));
}));

// iPhone 桌面小工具（Scriptable）讀的精簡資料
app.get('/api/widget', auth, (req, res) => {
  const view = meView(req.user);
  res.json({
    myName: view.me.name,
    partnerName: view.partner?.name ?? null,
    startDate: view.couple?.startDate ?? null,
    pinned: view.pinned && { text: view.pinned.text, fromName: view.pinned.fromName, createdAt: view.pinned.createdAt },
  });
});

// 手機端回報的狀態與錯誤（只印在終端機，方便除錯）
app.post('/api/client-log', (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const who = db.users[tokenIndex.get(token)]?.name || '未登入';
  const b = req.body || {};
  const where = b.inAppBrowser ? `${b.inAppBrowser} 內建瀏覽器` : b.standalone ? '主畫面 App' : '瀏覽器分頁';
  const clip = (v, n) => String(v ?? '').slice(0, n);
  console.log(`📱 ${clip(who, 20)}｜${clip(b.platform, 10)}｜${where}｜推播支援 ${b.pushSupported ? '有' : '無'}｜權限 ${clip(b.permission, 12)}｜${clip(b.message, 300)}`);
  res.status(204).end();
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, '找不到這個 API')));
app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? '伺服器發生錯誤' : err.message });
});

const server = app.listen(PORT, () => {
  console.log(`與你連線 啟動中 → http://localhost:${PORT}（資料存在 ${storage.kind}）`);
});

// 雲端主機休眠或重新部署前會送 SIGTERM：等最後一次寫入完成再結束
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`收到 ${signal}，儲存後關閉…`);
    server.close();
    saving.catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}

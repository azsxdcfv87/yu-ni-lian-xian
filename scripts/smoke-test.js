// 端對端冒煙測試：啟動真正的 server + 一個本機 HTTPS「假推播服務」，
// 走完 建立→配對→訂閱→傳訊息→釘選 的流程，並把推播內容解密驗證。
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuni-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 假推播服務（HTTPS，自簽憑證） ----------
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
const received = [];
const mock = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/gone')) { res.writeHead(410).end(); return; }
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201).end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `https://127.0.0.1:${mock.address().port}`;

// 模擬瀏覽器端的推播金鑰
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const uaAuth = crypto.randomBytes(16);
const fakeSub = (p) => ({ endpoint: `${MOCK}${p}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } });

// RFC 8291 aes128gcm 解密
function decrypt(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, uaAuth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, '最後一個 record 的分隔字元應為 0x02');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

// ---------- 啟動 server ----------
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 50 && !serverLog.includes('啟動中'); i++) await new Promise((r) => setTimeout(r, 100));

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

try {
  let A; let B; let code;
  const start = new Date(Date.now() - 99 * 86400000).toISOString().slice(0, 10);

  await step('靜態檔案與 VAPID 公鑰', async () => {
    for (const p of ['/', '/sw.js', '/manifest.webmanifest', '/icons/apple-touch-icon.png', '/widget-template.js']) {
      assert.equal((await fetch(BASE + p)).status, 200, p);
    }
    const { json } = await call('GET', '/api/vapid-public-key');
    assert.equal(Buffer.from(json.key, 'base64url').length, 65);
  });

  await step('建立兩個使用者，A 建立情侶空間', async () => {
    A = (await call('POST', '/api/users', { name: '胖胖' })).json.token;
    B = (await call('POST', '/api/users', { name: '連連' })).json.token;
    assert.ok(A && B);
    const r = await call('POST', '/api/couples', { startDate: start }, A);
    assert.equal(r.status, 201);
    code = r.json.couple.code;
    assert.match(code, /^[A-Z2-9]{6}$/);
    assert.equal(r.json.couple.paired, false);
  });

  await step('驗證錯誤：未來日期、錯誤配對碼、自己的配對碼、未登入', async () => {
    assert.equal((await call('POST', '/api/couples', { startDate: '2999-01-01' }, A)).status, 400);
    assert.equal((await call('POST', '/api/couples', { startDate: '2025-02-30' }, A)).status, 400);
    assert.equal((await call('POST', '/api/couples/join', { code: 'ZZZZZZ' }, B)).status, 404);
    assert.equal((await call('POST', '/api/couples/join', { code }, A)).status, 400);
    assert.equal((await call('GET', '/api/me')).status, 401);
    assert.equal((await call('POST', '/api/messages', { text: 'hi' }, A)).status, 409);
  });

  await step('A 訂閱推播後，B 用小寫加空白的配對碼加入 → A 收到「已連線」推播', async () => {
    assert.equal((await call('POST', '/api/subscriptions', fakeSub('/a'), A)).status, 201);
    const r = await call('POST', '/api/couples/join', { code: ` ${code.toLowerCase()} ` }, B);
    assert.equal(r.status, 200);
    assert.equal(r.json.couple.paired, true);
    assert.equal(r.json.partner.name, '胖胖');
    assert.equal((await call('POST', '/api/couples/join', { code }, (await call('POST', '/api/users', { name: 'C' })).json.token)).status, 409);
    for (let i = 0; i < 30 && !received.length; i++) await new Promise((res) => setTimeout(res, 50));
    const push = decrypt(received.shift().body);
    assert.match(push.body, /連連 已經和你連線了/);
  });

  await step('B 訂閱推播（含一個已失效的訂閱）', async () => {
    await call('POST', '/api/subscriptions', fakeSub('/gone'), B);
    const r = await call('POST', '/api/subscriptions', fakeSub('/b'), B);
    assert.equal(r.json.pushDevices, 2);
  });

  await step('A 傳「釘在通知列＋釘在對方首頁」→ 推播內容正確、失效訂閱被清掉', async () => {
    const r = await call('POST', '/api/messages', { text: '晚安，夢裡見 🌙', notify: true, pinNotification: true, pinHome: true }, A);
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.push, { sent: 1, failed: 1 });
    assert.equal(r.json.partnerPinned.text, '晚安，夢裡見 🌙');
    const req = received.shift();
    assert.equal(req.url, '/b');
    assert.equal(req.headers['content-encoding'], 'aes128gcm');
    assert.match(req.headers.authorization, /^vapid t=.+, k=.+/);
    assert.equal(req.headers.urgency, 'high');
    const push = decrypt(req.body);
    assert.deepEqual(push, { title: '📌 胖胖', body: '晚安，夢裡見 🌙', tag: 'pinned', requireInteraction: true, url: '/' });
    assert.equal((await call('GET', '/api/me', null, B)).json.me.pushDevices, 1);
  });

  await step('B 的首頁與小工具看得到釘選和天數資料', async () => {
    const me = (await call('GET', '/api/me', null, B)).json;
    assert.equal(me.pinned.text, '晚安，夢裡見 🌙');
    assert.equal(me.pinned.fromName, '胖胖');
    assert.equal(me.messages.length, 1);
    const w = (await call('GET', '/api/widget', null, B)).json;
    assert.deepEqual(Object.keys(w).sort(), ['myName', 'partnerName', 'pinned', 'startDate']);
    assert.equal(w.startDate, start);
    assert.equal(w.partnerName, '胖胖');
  });

  await step('一般訊息：不釘選、tag 唯一；關掉通知就不推播', async () => {
    await call('POST', '/api/messages', { text: '想你了 💭', notify: true, pinNotification: false, pinHome: false }, B);
    const push = decrypt(received.shift().body);
    assert.equal(push.requireInteraction, false);
    assert.match(push.tag, /^msg-/);
    const r = await call('POST', '/api/messages', { text: '安靜的一句', notify: false, pinNotification: true, pinHome: false }, B);
    assert.equal(r.json.push.sent, 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(received.length, 0);
  });

  await step('自己釘選／取消釘選；訊息長度限制', async () => {
    const me = (await call('GET', '/api/me', null, A)).json;
    const target = me.messages.find((m) => m.text === '想你了 💭');
    assert.equal((await call('POST', '/api/pin', { messageId: target.id }, A)).json.pinned.text, '想你了 💭');
    assert.equal((await call('POST', '/api/pin', { messageId: null }, A)).json.pinned, null);
    assert.equal((await call('POST', '/api/pin', { messageId: 'nope' }, A)).status, 404);
    assert.equal((await call('POST', '/api/messages', { text: '字'.repeat(201) }, A)).status, 400);
  });

  await step('資料有寫入磁碟（db.json、vapid.json）', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf8'));
    assert.equal(Object.keys(saved.couples).length, 1);
    assert.ok(fs.existsSync(path.join(tmp, 'vapid.json')));
  });

  console.log(`\n全部通過（${passed} 項）`);
} catch (err) {
  console.error(`\n✗ 失敗：${err.message}\n`, err);
  console.error('--- server log ---\n', serverLog);
  process.exitCode = 1;
} finally {
  server.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

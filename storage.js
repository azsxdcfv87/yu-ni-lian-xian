// 與你連線 — 資料儲存層
//   有 Firebase 金鑰 → 存在 Firestore（雲端部署用，主機重開資料也不會不見）
//   沒有金鑰       → 存在 data/ 資料夾的 JSON 檔（本機開發用）
//
// 資料量很小（兩個人），所以整份資料存成一份文件，讀寫都最單純。
import fs from 'node:fs';
import path from 'node:path';

const EMPTY_DB = () => ({ users: {}, couples: {}, messages: {} });

// Firebase 服務帳戶金鑰的來源（任一即可）：
//   1. 環境變數 FIREBASE_SERVICE_ACCOUNT：金鑰 JSON 原文，或它的 base64
//   2. 檔案：FIREBASE_KEY_FILE 指定的路徑，或 Render Secret File 的 /etc/secrets/firebase-key.json
function loadFirebaseCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  const file = process.env.FIREBASE_KEY_FILE || '/etc/secrets/firebase-key.json';
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

function fileStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'db.json');
  const vapidFile = path.join(dataDir, 'vapid.json');
  const writeAtomic = (file, value) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    kind: `檔案（${dataDir}）`,
    async load() { return fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : EMPTY_DB(); },
    async save(db) { writeAtomic(dbFile, db); },
    async loadVapid() { return fs.existsSync(vapidFile) ? JSON.parse(fs.readFileSync(vapidFile, 'utf8')) : null; },
    async saveVapid(keys) { writeAtomic(vapidFile, keys); },
  };
}

async function firestoreStorage(credentials) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const firebase = initializeApp({ credential: cert(credentials) });
  const store = getFirestore(firebase);
  const stateDoc = store.collection('app').doc('state');
  const vapidDoc = store.collection('app').doc('vapid');
  return {
    kind: `Firestore（${credentials.project_id}）`,
    async load() {
      const snap = await stateDoc.get();
      return snap.exists ? JSON.parse(snap.get('json')) : EMPTY_DB();
    },
    // 存成 JSON 字串：避開 Firestore 欄位名稱與巢狀陣列的限制
    async save(db) { await stateDoc.set({ json: JSON.stringify(db), updatedAt: new Date() }); },
    async loadVapid() {
      const snap = await vapidDoc.get();
      return snap.exists ? { publicKey: snap.get('publicKey'), privateKey: snap.get('privateKey') } : null;
    },
    async saveVapid(keys) { await vapidDoc.set(keys); },
  };
}

export async function createStorage({ dataDir }) {
  const credentials = loadFirebaseCredentials();
  return credentials ? firestoreStorage(credentials) : fileStorage(dataDir);
}

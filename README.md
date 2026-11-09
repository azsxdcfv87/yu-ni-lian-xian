# 嵎你連線 💞

情侶專屬的 PWA 原型：iPhone 和 Android 都能用，不需要 Apple 開發者帳號。

- **交往天數**：當天算第 1 天，並顯示下一個百日和週年還有幾天
- **配對**：一方建立空間拿到 6 碼配對碼，另一方輸入後完成連線
- **傳一句話**：可以分別選擇
  - 傳送通知（Web Push）
  - 釘在通知列：通知不會自動收起，滑掉前都在
  - 釘在對方首頁：顯示在對方 App 首頁和 iPhone 桌面小工具
- **iPhone 桌面小工具**：用免費的 Scriptable App 顯示天數和釘選的話

## 專案結構

```
server.js                 後端：Express + web-push，資料存在 data/db.json
public/
  index.html, app.js      前端（無框架、免編譯）
  styles.css              淺色／深色模式
  sw.js                   Service Worker：收推播、點通知開 App、離線快取
  manifest.webmanifest    PWA 設定
  widget-template.js      Scriptable 小工具範本（App 設定頁會自動填好網址和登入碼）
  icons/                  由 scripts/make-icons.js 產生
scripts/
  smoke-test.js           端對端測試：含本機假推播服務，並把推播內容解密驗證
  make-icons.js           產生 App 圖示
```

## 在電腦上跑

```bash
npm install
npm start          # http://localhost:3000
npm test           # 端對端測試
```

第一次啟動會自動產生 VAPID 推播金鑰，存在 `data/vapid.json`。

在同一台電腦上想模擬兩個人，可以一個分頁開 `http://localhost:3000`，另一個開 `http://127.0.0.1:3000`。兩個網址的登入資料是分開的。

## 用兩支手機實測

推播必須走 **HTTPS**，最快的方法是用 Cloudflare 的免費臨時通道：

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

終端機會印出一個 `https://xxxx.trycloudflare.com` 網址，兩支手機都打開它。

**你的 Android（Chrome）**
1. 打開網址，點選單裡的「加到主畫面」或「安裝應用程式」
2. 輸入暱稱，點「建立我們的空間」，選交往日
3. 點「開啟通知」，然後允許

**她的 iPhone（需要 iOS 16.4 以上）**
1. 用 **Safari** 打開網址，點「分享」，再選「加入主畫面」
2. **從桌面圖示打開**，再輸入暱稱和你的配對碼
   （主畫面 App 和 Safari 的資料是分開的，請直接在主畫面 App 裡註冊）
3. 點「開啟通知」，然後允許

**iPhone 桌面小工具**
1. App Store 下載「Scriptable」
2. 在「嵎你連線」點設定，再點「複製小工具程式碼」
3. 打開 Scriptable，點「＋」，貼上，命名為「嵎你連線」
4. 長按桌面，點「＋」，選 Scriptable，再到編輯小工具裡選「嵎你連線」

> ⚠️ 臨時通道每次重開網址都會變，主畫面 App、推播訂閱和小工具都要重設。只適合測試用。

## 平台限制

| | Android（Chrome） | iPhone（主畫面 PWA） |
|---|---|---|
| 推播通知 | ✅ | ✅ iOS 16.4 以上，必須從主畫面打開 |
| 釘在通知列 | ✅ 不會自動收起，滑掉才消失 | ⚠️ 照一般通知顯示，會留在通知中心 |
| 圖示紅點 | 依桌面啟動器支援程度 | ✅ |
| 桌面小工具 | ❌ PWA 做不到，之後要做原生 App | ✅ 透過 Scriptable，大約 15 分鐘到 1 小時更新一次 |

## 要長期使用的話

1. **固定網址**：PWA、推播訂閱和小工具都綁定網址，網址一換就要重設。可以用自己的網域搭配 Cloudflare 具名通道，放在一台一直開著的電腦上；或改放到 VPS。
2. **固定 VAPID 金鑰**：設定環境變數 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（`mailto:你的信箱`）。金鑰換掉，所有推播訂閱都會失效。
3. **資料保存**：目前用 JSON 檔，主機重開後必須保留 `data/` 資料夾。免費雲端主機常常不保留磁碟，到時可以改接 Firebase Firestore 或 Supabase。
4. **安全性**：登入碼等同密碼，目前沒有密碼登入，也沒有對登入碼做雜湊，只適合你們兩個人自己用。

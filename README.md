# 與你連線 💞

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
server.js                 後端：Express + web-push
storage.js                資料儲存：有 Firebase 金鑰存 Firestore，否則存 data/ 的 JSON 檔
render.yaml               Render 部署設定
.github/workflows/        防休眠排程（每 10 分鐘叫醒 Render）
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

推播必須走 **HTTPS**。這個專案用 **Tailscale Funnel** 提供固定網址（免費、網址不會變）：

```bash
brew install --cask tailscale-app      # 需要輸入 Mac 密碼，裝好後登入 Tailscale
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 3000
```

第一次執行會給一個連結，要在 Tailscale 網頁上同意開啟 Funnel。開通後網址會是
`https://<電腦名稱>.<tailnet>.ts.net`，設定會保留，重開機也不用重設；只要 `npm start` 有在跑就能連。

- 查看狀態：`tailscale funnel status`
- 關閉公開：`tailscale funnel --https=443 off`

> 臨時測試也可以用 `cloudflared tunnel --url http://localhost:3000`，但網址每次都會變，而且一兩個小時就可能失效。

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
2. 在「與你連線」點設定，再點「複製小工具程式碼」
3. 打開 Scriptable，點「＋」，貼上，命名為「與你連線」
4. 長按桌面，點「＋」，選 Scriptable，再到編輯小工具裡選「與你連線」

> ⚠️ 網址一換，主畫面 App、推播訂閱和小工具都要重設；用 Tailscale 固定網址就不會有這個問題。
> 如果對方換手機或 iPhone 從主畫面打開變成沒登入，到「設定 → 重新配對」產生新的配對碼即可，訊息會保留。

## 平台限制

| | Android（Chrome） | iPhone（主畫面 PWA） |
|---|---|---|
| 推播通知 | ✅ | ✅ iOS 16.4 以上，必須從主畫面打開 |
| 釘在通知列 | ✅ 不會自動收起，滑掉才消失 | ⚠️ 照一般通知顯示，會留在通知中心 |
| 圖示紅點 | 依桌面啟動器支援程度 | ✅ |
| 桌面小工具 | ❌ PWA 做不到，之後要做原生 App | ✅ 透過 Scriptable，大約 15 分鐘到 1 小時更新一次 |

## 部署到雲端（Render 免費方案＋Firebase）

Mac 不用一直開著。資料存在 Firebase Firestore，主機重開或重新部署都不會不見；推播金鑰第一次啟動時自動產生，也存在 Firestore。

**1. 建立 Firebase 專案與金鑰**
1. 到 [Firebase 主控台](https://console.firebase.google.com/) 新增專案（Google Analytics 可以不開）
2. 左側「建構 → Firestore Database」→ 建立資料庫，**選「正式版模式（production mode）」**，位置選 `asia-east1`（台灣）
3. 右上齒輪「專案設定 → 服務帳戶」→「產生新的私密金鑰」，下載 JSON 檔（**等同密碼，不要放進 GitHub**）

**2. 在 Render 建立服務**
1. 用 GitHub 登入 [Render](https://render.com/)
2. New → **Blueprint** → 選這個 repo，Render 會讀 `render.yaml`
3. 提示輸入 `FIREBASE_SERVICE_ACCOUNT` 時，貼上剛下載的金鑰 JSON 全文
4. 部署完成後，網址是 `https://<服務名稱>.onrender.com`，打開 `/healthz` 應該看到 `"storage":"Firestore"`

**3. 開啟防休眠**
在 GitHub repo 的 Settings → Secrets and variables → Actions → **Variables** 新增 `APP_URL`（Render 網址），
`.github/workflows/keepalive.yml` 就會每 10 分鐘叫醒伺服器。

> Render 免費方案：閒置 15 分鐘休眠、每月 750 小時免費額度（一個服務全天開著約 744 小時，剛好夠）。
> GitHub 的排程在 repo 60 天沒有任何活動後會自動停用，到時到 Actions 頁面重新啟用即可。

## 注意事項

1. **網址**：PWA、推播訂閱和小工具都綁定網址，網址一換就要重設。想要永久不變，可以買自己的網域綁到 Render。
2. **VAPID 金鑰**：存在 Firestore（或本機 `data/vapid.json`），也可以用環境變數 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` 指定。金鑰換掉，所有推播訂閱都會失效。
3. **安全性**：登入碼等同密碼，目前沒有密碼登入，也沒有對登入碼做雜湊，只適合你們兩個人自己用。

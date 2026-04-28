# 🛣 台灣高速公路路況查詢

GitHub Pages + Cloudflare Worker 方案，串接交通部 TDX 即時路況資料。

```
使用者瀏覽器
  └─ GitHub Pages (docs/)          ← 靜態前端，免費
       └─ Cloudflare Worker        ← 代理 + Token，免費
            └─ TDX API             ← 交通部官方資料
```

## 部署步驟

### Step 1 — Fork 並啟用 GitHub Pages

1. Fork 此 repo 到你的 GitHub
2. Settings → Pages → Source: **Deploy from branch**
3. Branch: `main` / Folder: `/docs` → Save
4. 等約 1 分鐘後，頁面網址為 `https://yourname.github.io/tdx-highway-web`

### Step 2 — 建立 Cloudflare Worker

1. 前往 [dash.cloudflare.com](https://dash.cloudflare.com) 免費註冊
2. **Workers & Pages** → **Create Worker**
3. 將 `worker/index.js` 全部內容貼入編輯器
4. 點 **Deploy**

### Step 3 — 設定 TDX 金鑰（環境變數）

Worker 部署後，進入 Worker 頁面：

**Settings → Variables and Secrets** → Add variable

| 變數名稱 | 值 |
|---|---|
| `TDX_CLIENT_ID` | 你的 TDX Client ID |
| `TDX_CLIENT_SECRET` | 你的 TDX Client Secret |

點 **Save and deploy**。

> 申請 TDX 金鑰：[tdx.transportdata.tw](https://tdx.transportdata.tw) → 免費註冊 → 審核約 1–3 工作天

### Step 4 — 填入 Worker URL

編輯 `docs/config.js`：

```js
const WORKER_URL = 'https://tdx-highway.yourname.workers.dev';
```

Commit & push，GitHub Pages 會自動更新。

---

## 費用

| 服務 | 費用 |
|---|---|
| GitHub Pages | 免費 |
| Cloudflare Workers（免費方案） | 每日 10 萬次請求，完全足夠 |
| TDX API（一般會員） | 免費申請 |

**全部免費！**

---

## API 路由（Worker）

| 路由 | 說明 | 參數 |
|---|---|---|
| `GET /api/ping` | 健康檢查 / Token 測試 | — |
| `GET /api/speed` | 即時車速 | `road`, `direction`, `kmFrom`, `kmTo` |
| `GET /api/incident` | 事故 / 施工 | `road` |
| `GET /api/vd` | VD 偵測器資料 | `road`, `direction` |

### 參數說明

| 參數 | 值 | 說明 |
|---|---|---|
| `road` | `1` `3` `5` ... | 國道號碼 |
| `direction` | `N` / `S` | 北上/東向 或 南下/西向 |
| `kmFrom` | 數字 | 起始里程（公里） |
| `kmTo` | 數字 | 結束里程（公里） |

---

## 本機開發

```bash
# 安裝 Wrangler CLI
npm install -g wrangler

# 登入 Cloudflare
wrangler login

# 本機模擬 Worker（需先設定 .dev.vars）
cd worker
wrangler dev

# 部署
wrangler deploy
```

`.dev.vars` 範例：
```
TDX_CLIENT_ID=your-client-id
TDX_CLIENT_SECRET=your-client-secret
```

---

## 資料來源

交通部 TDX 運輸資料流通服務平臺  
https://tdx.transportdata.tw

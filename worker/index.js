/**
 * Cloudflare Worker — TDX 高速公路路況代理
 *
 * 部署步驟：
 *   1. 登入 https://dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. 貼上此檔案內容並部署
 *   3. 在 Worker Settings → Variables 設定：
 *      TDX_CLIENT_ID     = 你的 Client ID
 *      TDX_CLIENT_SECRET = 你的 Client Secret
 *   4. 複製 Worker URL，填入前端 docs/config.js
 */

const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_API_BASE  = 'https://tdx.transportdata.tw/api/basic';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Token 快取（Worker 執行期間有效）──────────────────────────
let cachedToken  = null;
let tokenExpiry  = 0;

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(TDX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`Token 失敗 (${res.status})`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── 通用 TDX API 呼叫 ─────────────────────────────────────────
async function tdxFetch(path, env) {
  const token = await getToken(env);
  const res = await fetch(`${TDX_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TDX API 失敗 (${res.status})`);
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── 路由處理 ──────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      // ── /api/speed?road=1&direction=N&kmFrom=150&kmTo=180
      if (url.pathname === '/api/speed') {
        const road      = url.searchParams.get('road')      || '1';
        const direction = url.searchParams.get('direction') || 'N';
        const kmFrom    = url.searchParams.get('kmFrom');
        const kmTo      = url.searchParams.get('kmTo');

        let filter = `RoadID eq 'N${road}' and Direction eq '${direction}'`;
        if (kmFrom) filter += ` and LocationMile ge ${kmFrom}`;
        if (kmTo)   filter += ` and LocationMile le ${kmTo}`;

        const path = `/v2/Road/Traffic/Live/Freeway/LiveTraffic?$filter=${encodeURIComponent(filter)}&$orderby=LocationMile&$format=JSON&$top=100`;
        const data = await tdxFetch(path, env);
        return json(data);
      }

      // ── /api/incident?road=1
      if (url.pathname === '/api/incident') {
        const road   = url.searchParams.get('road') || '1';
        const filter = `RoadID eq 'N${road}'`;
        const path   = `/v2/Road/Traffic/Incident/Freeway?$filter=${encodeURIComponent(filter)}&$format=JSON&$top=30`;
        const data   = await tdxFetch(path, env);
        return json(data);
      }

      // ── /api/vd?road=1&direction=N
      if (url.pathname === '/api/vd') {
        const road      = url.searchParams.get('road')      || '1';
        const direction = url.searchParams.get('direction') || 'N';
        const filter    = `RoadID eq 'N${road}' and Direction eq '${direction}'`;
        const path      = `/v2/Road/Traffic/VD/Freeway/VDLive?$filter=${encodeURIComponent(filter)}&$format=JSON&$top=100`;
        const data      = await tdxFetch(path, env);
        return json(data);
      }

      // ── /api/ping — 健康檢查
      if (url.pathname === '/api/ping') {
        await getToken(env);
        return json({ ok: true, message: 'Token 取得成功，Worker 運作正常' });
      }

      return json({ error: '找不到路由' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

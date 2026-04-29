/**
 * Cloudflare Worker — TDX 高速公路路況代理 v3
 * 修正：正確 API 路徑與欄位名稱
 *   - 國道編號透過 URL path 傳入，不用 $filter RoadID
 *   - 欄位名稱：SectionID, TravelSpeed, TravelTime（無 RoadID / Direction / LocationMile）
 */

const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_API_BASE  = 'https://tdx.transportdata.tw/api/basic';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let cachedToken = null;
let tokenExpiry = 0;

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET)
    throw new Error('環境變數未設定：TDX_CLIENT_ID / TDX_CLIENT_SECRET');

  const res = await fetch(TDX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error_description || msg; } catch(_) {}
    throw new Error(`Token 失敗 (${res.status})：${msg}`);
  }

  const d = JSON.parse(text);
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

async function tdxGet(path, env) {
  const token = await getToken(env);
  const res = await fetch(`${TDX_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).Message || JSON.parse(text).message || msg; } catch(_) {}
    throw new Error(`TDX API 失敗 (HTTP ${res.status})：${msg}`);
  }
  return JSON.parse(text);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {

      // GET /api/ping
      if (url.pathname === '/api/ping') {
        await getToken(env);
        return json({ ok: true, message: 'Token 取得成功，Worker 運作正常' });
      }

      // GET /api/debug
      if (url.pathname === '/api/debug') {
        return json({
          hasClientId:     !!env.TDX_CLIENT_ID,
          hasClientSecret: !!env.TDX_CLIENT_SECRET,
          clientIdPrefix:  env.TDX_CLIENT_ID?.slice(0, 8) + '...',
        });
      }

      // GET /api/speed?road=1&direction=N
      // 正確路徑：/v2/Road/Traffic/Live/Freeway/{FreewayID}
      // FreewayID 格式：國道一號 = 1（API 可能為 "N1" 或純數字，先試純數字）
      // direction 無法用 OData filter，改為前端自行過濾或不傳
      if (url.pathname === '/api/speed') {
        const road = url.searchParams.get('road') || '1';

        // TDX 路況 API：以國道編號為路徑參數
        const path = `/v2/Road/Traffic/Live/Freeway/${road}?$format=JSON&$top=200`;
        const data = await tdxGet(path, env);

        // 回傳整個回應讓前端決定怎麼用
        return json(data);
      }

      // GET /api/incident?road=1
      if (url.pathname === '/api/incident') {
        const road = url.searchParams.get('road') || '1';
        const path = `/v2/Road/Traffic/Incident/Freeway/${road}?$format=JSON&$top=50`;
        const data = await tdxGet(path, env);
        return json(data);
      }

      // GET /api/schema?road=1  ← 新增：查看實際欄位結構，方便除錯
      if (url.pathname === '/api/schema') {
        const road = url.searchParams.get('road') || '1';
        const path = `/v2/Road/Traffic/Live/Freeway/${road}?$format=JSON&$top=1`;
        const data = await tdxGet(path, env);
        // 只回傳第一筆讓使用者看欄位
        const items = Array.isArray(data) ? data : (data.LiveTrafficList?.LiveTraffic || data.value || [data]);
        return json({ sampleRecord: items[0] || null, totalCount: items.length });
      }

      return json({ error: '路由不存在' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
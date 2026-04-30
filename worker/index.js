/**
 * Cloudflare Worker — TDX 高速公路路況代理 v5
 * 修正：正確 domain 與路徑
 *   domain: traffic.transportdata.tw
 *   路徑:   /MOTC/v2/Road/Traffic/Live/Freeway
 *   資料:   LiveTrafficList.LiveTraffic[].SectionID / TravelSpeed / TravelTime
 */

const TOKEN_URL  = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TRAFFIC_BASE = 'https://traffic.transportdata.tw/MOTC';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let cachedToken = null;
let tokenExpiry  = 0;

// ── Token ────────────────────────────────────────────────────
async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  if (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET)
    throw new Error('Worker 環境變數未設定：TDX_CLIENT_ID / TDX_CLIENT_SECRET');

  const res = await fetch(TOKEN_URL, {
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
    throw new Error('Token 失敗 (' + res.status + ')：' + msg);
  }
  const d = JSON.parse(text);
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

// ── 呼叫 traffic.transportdata.tw ────────────────────────────
async function trafficGet(path, env) {
  const token = await getToken(env);
  const url   = TRAFFIC_BASE + path;
  const res   = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).Message || JSON.parse(text).message || msg; } catch(_) {}
    throw new Error('API 失敗 (' + res.status + ')：' + msg);
  }
  return JSON.parse(text);
}

function json(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

// ── 速度分級 ─────────────────────────────────────────────────
function levelOf(speed) {
  if (speed <= 0)  return '無資料';
  if (speed >= 80) return '順暢';
  if (speed >= 40) return '壅塞';
  return '嚴重壅塞';
}

// ── Worker ───────────────────────────────────────────────────
addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request, event));
});

async function handleRequest(request, event) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const road      = url.searchParams.get('road')      || '';   // '1','3',...
  const direction = url.searchParams.get('direction') || '';   // 'N' or 'S'
  const kmFrom    = url.searchParams.get('kmFrom')    || '';
  const kmTo      = url.searchParams.get('kmTo')      || '';

  try {

    // /api/ping
    if (pathname === '/api/ping') {
      await getToken(event.env || {});
      return json({ ok: true, message: 'Token 取得成功，Worker 運作正常' });
    }

    // /api/debug — 不需要 token，直接確認環境變數
    if (pathname === '/api/debug') {
      const env = event.env || {};
      return json({
        hasClientId:     !!env.TDX_CLIENT_ID,
        hasClientSecret: !!env.TDX_CLIENT_SECRET,
        clientIdPrefix:  env.TDX_CLIENT_ID ? env.TDX_CLIENT_ID.slice(0,8)+'...' : '未設定',
        trafficBase:     TRAFFIC_BASE,
      });
    }

    // /api/speed?road=1&direction=N&kmFrom=150&kmTo=200
    // 正確路徑: /v2/Road/Traffic/Live/Freeway
    // 回傳: { LiveTrafficList: { LiveTraffic: [...] } }
    // 欄位: SectionID, TravelSpeed(km/h), TravelTime(秒), Direction, StartMileage, EndMileage
    if (pathname === '/api/speed') {
      const env = event.env || {};

      let filter = '';
      const conditions = [];
      if (road)      conditions.push("contains(SectionID,'" + road + "')");
      if (direction) conditions.push("Direction eq '" + direction + "'");
      if (kmFrom)    conditions.push('StartMileage ge ' + kmFrom);
      if (kmTo)      conditions.push('EndMileage le ' + kmTo);
      if (conditions.length) filter = '$filter=' + encodeURIComponent(conditions.join(' and ')) + '&';

      const path = '/v2/Road/Traffic/Live/Freeway?' + filter + '$format=JSON&$top=200';
      const data = await trafficGet(path, env);

      // 展開 LiveTrafficList.LiveTraffic
      let items = [];
      if (Array.isArray(data)) {
        items = data;
      } else if (data.LiveTrafficList) {
        items = data.LiveTrafficList.LiveTraffic || [];
      } else if (data.value) {
        items = data.value;
      }

      const sections = items.map(function(item) {
        const spd = parseInt(item.TravelSpeed || 0, 10);
        return {
          sectionId:   item.SectionID  || '',
          direction:   item.Direction === 'N' ? '北上' : item.Direction === 'S' ? '南下' : (item.Direction || ''),
          directionRaw: item.Direction || '',
          startMile:   parseFloat(item.StartMileage || item.StartMile || 0) || 0,
          endMile:     parseFloat(item.EndMileage   || item.EndMile   || 0) || 0,
          speed:       spd,
          travelTime:  parseInt(item.TravelTime || 0, 10) || 0,
          level:       levelOf(spd),
          updateTime:  item.DataCollectTime || '',
        };
      });

      return json({
        updateTime: data.UpdateTime || new Date().toISOString(),
        count: sections.length,
        sections: sections,
        _rawSample: items.slice(0, 1),   // 保留第一筆原始欄位，方便除錯
      });
    }

    // /api/incident?road=1
    if (pathname === '/api/incident') {
      const env = event.env || {};
      let filter = '';
      if (road) filter = '$filter=' + encodeURIComponent("contains(RoadNo,'N" + road + "')") + '&';
      const path = '/v2/Road/Traffic/Incident/Freeway?' + filter + '$format=JSON&$top=50';
      const data = await trafficGet(path, env);

      let items = [];
      if (Array.isArray(data)) items = data;
      else if (data.IncidentList) items = data.IncidentList.Incident || [];
      else if (data.value) items = data.value;

      const events = items.map(function(e) {
        return {
          roadNo:      e.RoadNo || '',
          direction:   e.Direction === 'N' ? '北上' : e.Direction === 'S' ? '南下' : (e.Direction || ''),
          milestone:   parseFloat(e.Mileage || e.Milestone || 0) || 0,
          eventType:   e.IncidentType || e.EventType || '',
          description: e.Description || e.Memo || '',
          startTime:   e.StartTime || '',
          endTime:     e.EndTime || '',
        };
      });

      return json({
        updateTime: data.UpdateTime || new Date().toISOString(),
        count: events.length,
        events: events,
        _rawSample: items.slice(0, 1),
      });
    }

    // /api/raw?path=/v2/Road/Traffic/Live/Freeway — 除錯用，看原始回傳
    if (pathname === '/api/raw') {
      const env  = event.env || {};
      const p    = url.searchParams.get('path') || '/v2/Road/Traffic/Live/Freeway';
      const data = await trafficGet(p + '?$format=JSON&$top=1', env);
      return json({ raw: data });
    }

    return json({ error: '路由不存在。可用：/api/ping /api/debug /api/speed /api/incident /api/raw' }, 404);

  } catch(e) {
    return json({ error: e.message }, 500);
  }
}
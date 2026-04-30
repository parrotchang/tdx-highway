/**
 * Cloudflare Worker — TDX 高速公路路況代理 v5b
 * 修正：Service Worker 語法用 self.TDX_CLIENT_ID 讀環境變數
 *       （不是 event.env，那是 ES Module 語法）
 */

const TOKEN_URL    = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TRAFFIC_BASE = 'https://traffic.transportdata.tw/MOTC';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let cachedToken = null;
let tokenExpiry  = 0;

// ── 讀環境變數（Service Worker 語法用 self.XXX）──────────────
function getEnv(key) {
  // Service Worker 模式：變數掛在 global scope（即 self）
  if (typeof self !== 'undefined' && self[key]) return self[key];
  // 萬一是 ES Module 模式（不應該，但保險）
  if (typeof globalThis !== 'undefined' && globalThis[key]) return globalThis[key];
  return undefined;
}

// ── Token ────────────────────────────────────────────────────
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const clientId     = getEnv('TDX_CLIENT_ID');
  const clientSecret = getEnv('TDX_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error(
      '環境變數未設定。請到 Cloudflare Worker → Settings → Variables and Secrets ' +
      '新增 TDX_CLIENT_ID 和 TDX_CLIENT_SECRET，然後 Save and deploy。' +
      '（目前讀到 clientId=' + clientId + '）'
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    var msg = text;
    try { msg = JSON.parse(text).error_description || msg; } catch(_) {}
    throw new Error('Token 失敗 (' + res.status + ')：' + msg);
  }

  var d = JSON.parse(text);
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

// ── 呼叫 traffic.transportdata.tw ────────────────────────────
async function trafficGet(path) {
  var token = await getToken();
  var url   = TRAFFIC_BASE + path;
  var res   = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  var text = await res.text();
  if (!res.ok) {
    var msg = text;
    try { msg = JSON.parse(text).Message || JSON.parse(text).message || msg; } catch(_) {}
    throw new Error('API 失敗 (' + res.status + ')：' + msg);
  }
  return JSON.parse(text);
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

function levelOf(speed) {
  if (speed <= 0)  return '無資料';
  if (speed >= 80) return '順暢';
  if (speed >= 40) return '壅塞';
  return '嚴重壅塞';
}

// ── 主處理 ───────────────────────────────────────────────────
async function handleRequest(request) {
  var url      = new URL(request.url);
  var pathname = url.pathname;

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  var road      = url.searchParams.get('road')      || '';
  var direction = url.searchParams.get('direction') || '';
  var kmFrom    = url.searchParams.get('kmFrom')    || '';
  var kmTo      = url.searchParams.get('kmTo')      || '';

  try {

    // /api/ping
    if (pathname === '/api/ping') {
      await getToken();
      return jsonResp({ ok: true, message: 'Token 取得成功，Worker 運作正常' });
    }

    // /api/debug — 確認環境變數
    if (pathname === '/api/debug') {
      var cid = getEnv('TDX_CLIENT_ID');
      var cs  = getEnv('TDX_CLIENT_SECRET');
      return jsonResp({
        hasClientId:     !!cid,
        hasClientSecret: !!cs,
        clientIdPrefix:  cid ? cid.slice(0, 8) + '...' : '未設定',
        trafficBase:     TRAFFIC_BASE,
        note: '如果 hasClientId=false，請到 Worker Settings → Variables and Secrets 新增後 Save and deploy',
      });
    }

    // /api/speed?road=1&direction=N
    if (pathname === '/api/speed') {
      var conditions = [];
      if (road)      conditions.push("contains(SectionID,'" + road + "')");
      if (direction) conditions.push("Direction eq '" + direction + "'");
      if (kmFrom)    conditions.push('StartMileage ge ' + kmFrom);
      if (kmTo)      conditions.push('EndMileage le '   + kmTo);

      var filterStr = conditions.length
        ? '$filter=' + encodeURIComponent(conditions.join(' and ')) + '&'
        : '';

      var data = await trafficGet('/v2/Road/Traffic/Live/Freeway?' + filterStr + '$format=JSON&$top=200');

      var items = [];
      if (Array.isArray(data))                              items = data;
      else if (data.LiveTrafficList && data.LiveTrafficList.LiveTraffic) items = data.LiveTrafficList.LiveTraffic;
      else if (data.value)                                  items = data.value;

      var sections = items.map(function(item) {
        var spd = parseInt(item.TravelSpeed || 0, 10);
        return {
          sectionId:    item.SectionID || '',
          direction:    item.Direction === 'N' ? '北上' : item.Direction === 'S' ? '南下' : (item.Direction || ''),
          directionRaw: item.Direction || '',
          startMile:    parseFloat(item.StartMileage || 0) || 0,
          endMile:      parseFloat(item.EndMileage   || 0) || 0,
          speed:        spd,
          travelTime:   parseInt(item.TravelTime || 0, 10) || 0,
          level:        levelOf(spd),
        };
      });

      return jsonResp({
        updateTime: data.UpdateTime || new Date().toISOString(),
        count:    sections.length,
        sections: sections,
        _rawSample: items.slice(0, 1),
      });
    }

    // /api/incident?road=1
    if (pathname === '/api/incident') {
      var filterStr = road
        ? '$filter=' + encodeURIComponent("contains(RoadNo,'N" + road + "')") + '&'
        : '';
      var data = await trafficGet('/v2/Road/Traffic/Incident/Freeway?' + filterStr + '$format=JSON&$top=50');

      var items = [];
      if (Array.isArray(data))                              items = data;
      else if (data.IncidentList && data.IncidentList.Incident) items = data.IncidentList.Incident;
      else if (data.value)                                  items = data.value;

      var events = items.map(function(e) {
        return {
          roadNo:      e.RoadNo || '',
          direction:   e.Direction === 'N' ? '北上' : e.Direction === 'S' ? '南下' : (e.Direction || ''),
          milestone:   parseFloat(e.Mileage || 0) || 0,
          eventType:   e.IncidentType || e.EventType || '',
          description: e.Description || e.Memo || '',
          startTime:   e.StartTime || '',
        };
      });

      return jsonResp({
        updateTime: data.UpdateTime || new Date().toISOString(),
        count:  events.length,
        events: events,
        _rawSample: items.slice(0, 1),
      });
    }

    // /api/raw — 除錯用
    if (pathname === '/api/raw') {
      var p    = url.searchParams.get('path') || '/v2/Road/Traffic/Live/Freeway';
      var data = await trafficGet(p + '?$format=JSON&$top=1');
      return jsonResp({ raw: data });
    }

    return jsonResp({ error: '路由不存在' }, 404);

  } catch(e) {
    return jsonResp({ error: e.message }, 500);
  }
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});
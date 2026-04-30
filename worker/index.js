/**
 * Cloudflare Worker — TDX 高速公路路況代理 v6
 * 修正：正確 base URL = https://tdx.transportdata.tw/api/basic
 * 路況 API 路徑：/v2/Road/Traffic/Live/Freeway
 * VD  API 路徑：/v2/Road/Traffic/VD/Freeway
 */

const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE  = 'https://tdx.transportdata.tw/api/basic';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

var cachedToken = null;
var tokenExpiry  = 0;

function getEnv(key) {
  if (typeof self !== 'undefined' && self[key]) return self[key];
  return undefined;
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  var clientId     = getEnv('TDX_CLIENT_ID');
  var clientSecret = getEnv('TDX_CLIENT_SECRET');

  if (!clientId || !clientSecret)
    throw new Error('環境變數未設定：TDX_CLIENT_ID / TDX_CLIENT_SECRET');

  var res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(clientId) +
          '&client_secret=' + encodeURIComponent(clientSecret),
  });

  var text = await res.text();
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

async function apiGet(path) {
  var token = await getToken();
  var res   = await fetch(API_BASE + path, {
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

function levelOf(spd) {
  if (spd <= 0)  return '無資料';
  if (spd >= 80) return '順暢';
  if (spd >= 40) return '壅塞';
  return '嚴重壅塞';
}

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

    // /api/debug
    if (pathname === '/api/debug') {
      var cid = getEnv('TDX_CLIENT_ID');
      return jsonResp({
        hasClientId:     !!cid,
        hasClientSecret: !!getEnv('TDX_CLIENT_SECRET'),
        clientIdPrefix:  cid ? cid.slice(0,8)+'...' : '未設定',
        apiBase:         API_BASE,
      });
    }

    // /api/speed?road=1&direction=N&kmFrom=150&kmTo=200
    if (pathname === '/api/speed') {
      var conds = [];
      if (direction) conds.push("Direction eq '" + direction + "'");
      if (kmFrom)    conds.push('StartMileage ge ' + kmFrom);
      if (kmTo)      conds.push('EndMileage le '   + kmTo);

      // 國道用路徑參數傳入，不用 OData filter
      var roadPath = road ? '/N' + road : '';
      var qs = '$format=JSON&$top=200';
      if (conds.length) qs = '$filter=' + encodeURIComponent(conds.join(' and ')) + '&' + qs;

      var data  = await apiGet('/v2/Road/Traffic/Live/Freeway' + roadPath + '?' + qs);
      var items = [];
      if (Array.isArray(data))                items = data;
      else if (data.LiveTraffics)             items = data.LiveTraffics;
      else if (data.LiveTrafficList)          items = data.LiveTrafficList.LiveTraffic || [];
      else if (data.value)                    items = data.value;

      var sections = items.map(function(item) {
        var spd = parseInt(item.TravelSpeed || item.Speed || 0, 10);
        return {
          sectionId:  item.SectionID   || item.SectionId   || '',
          direction:  item.Direction === 'N' ? '北上' : item.Direction === 'S' ? '南下' : (item.Direction || ''),
          startMile:  parseFloat(item.StartMileage || item.StartMile || 0) || 0,
          endMile:    parseFloat(item.EndMileage   || item.EndMile   || 0) || 0,
          speed:      spd,
          travelTime: parseInt(item.TravelTime || 0, 10) || 0,
          level:      levelOf(spd),
          updateTime: item.DataCollectTime || item.UpdateTime || '',
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
      var roadPath = road ? '/N' + road : '';
      var data  = await apiGet('/v2/Road/Traffic/Incident/Freeway' + roadPath + '?$format=JSON&$top=50');
      var items = [];
      if (Array.isArray(data))       items = data;
      else if (data.Incidents)       items = data.Incidents;
      else if (data.IncidentList)    items = data.IncidentList.Incident || [];
      else if (data.value)           items = data.value;

      var events = items.map(function(e) {
        return {
          roadNo:      e.RoadNo || e.FreewayID || '',
          direction:   e.Direction === 'N' ? '北上' : e.Direction === 'S' ? '南下' : (e.Direction || ''),
          milestone:   parseFloat(e.Mileage || e.Milestone || 0) || 0,
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

    // /api/raw?path=/v2/Road/Traffic/Live/Freeway/N1 — 除錯
    if (pathname === '/api/raw') {
      var p    = url.searchParams.get('path') || '/v2/Road/Traffic/Live/Freeway/N1';
      var data = await apiGet(p + '?$format=JSON&$top=2');
      return jsonResp(data);
    }

    return jsonResp({ error: '路由不存在。可用：/api/ping /api/debug /api/speed /api/incident /api/raw' }, 404);

  } catch(e) {
    return jsonResp({ error: e.message }, 500);
  }
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});
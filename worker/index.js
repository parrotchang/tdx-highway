/**
 * Cloudflare Worker — TDX 高速公路路況代理 v7
 * 正確欄位：SectionID, TravelSpeed, TravelTime, CongestionLevel, CongestionLevelID
 * 說明：LiveTraffic 沒有 Direction / RoadID，需搭配靜態路段資料辨識路線
 *       /api/speed 回傳全部路段，前端可用 SectionID 前綴篩選
 *       /api/sections 回傳靜態路段基本資料（含路線、方向、里程）
 */

const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE  = 'https://tdx.transportdata.tw/api/basic';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

var cachedToken  = null;
var tokenExpiry  = 0;
var sectionCache = null;   // 靜態路段快取（不常變動）

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

  var res  = await fetch(TOKEN_URL, {
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

// 壅塞等級對照
function levelLabel(congestionLevel, speed) {
  var lvl = parseInt(congestionLevel || 0, 10);
  if (lvl === 1 || speed >= 80) return '順暢';
  if (lvl === 2 || speed >= 40) return '壅塞';
  if (lvl === 3 || speed > 0)   return '嚴重壅塞';
  return '無資料';
}

// 取靜態路段資料（含 RoadID、Direction、里程）
async function getSections() {
  if (sectionCache) return sectionCache;
  var data = await apiGet('/v2/Road/Traffic/Section/Freeway?$format=JSON&$top=1000');
  var items = Array.isArray(data) ? data : (data.Sections || data.value || []);
  // 建立 SectionID → 路段資訊 的 map
  var map = {};
  items.forEach(function(s) {
    map[s.SectionID] = {
      roadNo:     s.RoadNo || s.RoadID || '',
      direction:  s.Direction === 'N' ? '北上' : s.Direction === 'S' ? '南下' : (s.Direction || ''),
      directionRaw: s.Direction || '',
      startMile:  parseFloat(s.StartMileage || s.StartMile || 0) || 0,
      endMile:    parseFloat(s.EndMileage   || s.EndMile   || 0) || 0,
      sectionName: s.SectionName || s.Name || '',
    };
  });
  sectionCache = map;
  return map;
}

async function handleRequest(request) {
  var url      = new URL(request.url);
  var pathname = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  var road      = url.searchParams.get('road')      || '';  // '1','3'...
  var direction = url.searchParams.get('direction') || '';  // 'N','S'

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
        hasClientId: !!cid, hasClientSecret: !!getEnv('TDX_CLIENT_SECRET'),
        clientIdPrefix: cid ? cid.slice(0,8)+'...' : '未設定',
        apiBase: API_BASE,
      });
    }

    // /api/speed?road=1&direction=N
    // 先取靜態路段對照表，再取即時速度合併
    if (pathname === '/api/speed') {
      // 同時發出兩個請求
      var sectionMap = await getSections();
      var liveData   = await apiGet('/v2/Road/Traffic/Live/Freeway?$format=JSON&$top=2000');
      var items = Array.isArray(liveData) ? liveData : (liveData.LiveTraffics || liveData.value || []);

      var sections = [];
      items.forEach(function(item) {
        var sid  = item.SectionID || '';
        var info = sectionMap[sid] || {};

        // 依國道篩選
        if (road && info.roadNo && info.roadNo.replace('N','') !== road) return;
        // 依方向篩選
        if (direction && info.directionRaw && info.directionRaw !== direction) return;

        var spd = parseInt(item.TravelSpeed || 0, 10);
        sections.push({
          sectionId:   sid,
          sectionName: info.sectionName || sid,
          roadNo:      info.roadNo      || '',
          direction:   info.direction   || '',
          startMile:   info.startMile   || 0,
          endMile:     info.endMile     || 0,
          speed:       spd,
          travelTime:  parseInt(item.TravelTime || 0, 10),
          congestionLevel: item.CongestionLevel || '',
          congestionLevelID: item.CongestionLevelID || '',
          level:       levelLabel(item.CongestionLevel, spd),
          updateTime:  item.DataCollectTime || '',
        });
      });

      // 依里程排序
      sections.sort(function(a,b){ return a.startMile - b.startMile; });

      return jsonResp({
        updateTime: liveData.UpdateTime || new Date().toISOString(),
        count: sections.length,
        sections: sections,
      });
    }

    // /api/sections — 靜態路段基本資料（除錯 / 前端參考）
    if (pathname === '/api/sections') {
      var data  = await apiGet('/v2/Road/Traffic/Section/Freeway?$format=JSON&$top=1000');
      var items = Array.isArray(data) ? data : (data.Sections || data.value || []);
      if (road) items = items.filter(function(s){
        return (s.RoadNo||'').replace('N','') === road;
      });
      return jsonResp({ count: items.length, sections: items, _rawSample: items.slice(0,2) });
    }

    // /api/incident?road=1
    if (pathname === '/api/incident') {
      var data  = await apiGet('/v2/Road/Traffic/Incident/Freeway?$format=JSON&$top=100');
      var items = Array.isArray(data) ? data : (data.Incidents || data.IncidentList && data.IncidentList.Incident || data.value || []);
      if (road) items = items.filter(function(e){
        return (e.RoadNo||e.FreewayID||'').replace('N','') === road;
      });
      var events = items.map(function(e) {
        return {
          roadNo:      e.RoadNo || e.FreewayID || '',
          direction:   e.Direction === 'N' ? '北上' : e.Direction === 'S' ? '南下' : (e.Direction||''),
          milestone:   parseFloat(e.Mileage||e.Milestone||0)||0,
          eventType:   e.IncidentType || e.EventType || '',
          description: e.Description  || e.Memo || '',
          startTime:   e.StartTime || '',
        };
      });
      return jsonResp({ updateTime: data.UpdateTime||new Date().toISOString(), count: events.length, events: events, _rawSample: items.slice(0,1) });
    }

    // /api/raw — 除錯
    if (pathname === '/api/raw') {
      var p    = url.searchParams.get('path') || '/v2/Road/Traffic/Live/Freeway';
      var data = await apiGet(p + '?$format=JSON&$top=2');
      return jsonResp(data);
    }

    return jsonResp({ error: '路由不存在。可用：/api/ping /api/debug /api/speed /api/sections /api/incident /api/raw' }, 404);

  } catch(e) {
    return jsonResp({ error: e.message }, 500);
  }
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

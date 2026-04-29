/**
 * Cloudflare Worker — 高公局交通資料庫代理 v4b
 * 使用 Service Worker 語法（相容所有 Cloudflare Worker 設定）
 * 資料來源：tisvcloud.freeway.gov.tw（免費，不需要 API 金鑰）
 */

const BASE = 'https://tisvcloud.freeway.gov.tw/api/v2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── 極簡 XML 解析（Worker 沒有 DOMParser）─────────────────────
function xmlAttr(xml, tag, attr) {
  const re = new RegExp('<' + tag + '[^>]*\\s' + attr + '="([^"]*)"', 'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}

function xmlText(xml, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function parseItems(xml, tagName) {
  const items = [];
  const re = new RegExp('<' + tagName + '([^>]*?)(?:/>|>([\\s\\S]*?)<\\/' + tagName + '>)', 'gi');
  const attrRe = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const obj = {};
    const attrStr = m[1];
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(attrStr)) !== null) {
      obj[a[1].toLowerCase()] = a[2];
    }
    // 子元素
    if (m[2]) {
      const inner = m[2];
      const childRe = /<(\w+)[^>]*>([^<]*)<\/\1>/g;
      let c;
      while ((c = childRe.exec(inner)) !== null) {
        obj[c[1].toLowerCase()] = c[2].trim();
      }
    }
    items.push(obj);
  }
  return items;
}

// ── 抓 XML ────────────────────────────────────────────────────
async function fetchXML(path) {
  const res = await fetch(BASE + path, {
    headers: { 'Accept': 'application/xml, text/xml, */*' },
  });
  if (!res.ok) {
    throw new Error('高公局 API 失敗 (' + res.status + '): ' + path);
  }
  return res.text();
}

// ── JSON 回應 ─────────────────────────────────────────────────
function jsonResp(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json; charset=utf-8',
    }),
  });
}

// ── 資料處理 ──────────────────────────────────────────────────
function processRoadLevel(items, road, direction) {
  let filtered = items;
  if (road)      filtered = filtered.filter(function(s){ return s.roadno === 'N' + road || s.roadno === road; });
  if (direction) filtered = filtered.filter(function(s){ return s.direction === direction; });

  return filtered.map(function(s) {
    var dir = s.direction;
    return {
      roadNo:       s.roadno || '',
      direction:    dir === 'N' ? '北上' : dir === 'S' ? '南下' : dir,
      directionRaw: dir,
      sectionNo:    s.sectionno || s.sectionid || '',
      sectionName:  s.sectionname || s.name || '',
      startMile:    parseFloat(s.startmile || s.startmilestone || 0) || 0,
      endMile:      parseFloat(s.endmile   || s.endmilestone   || 0) || 0,
      speed:        parseInt(s.speed || 0, 10) || 0,
      travelTime:   parseInt(s.traveltime || 0, 10) || 0,
      level:        parseInt(s.levelofservice || s.level || 0, 10) || 0,
    };
  });
}

function processVD(items, road, direction) {
  var filtered = items;
  if (road)      filtered = filtered.filter(function(v){ return v.roadno === 'N' + road || v.roadno === road; });
  if (direction) filtered = filtered.filter(function(v){ return v.direction === direction; });

  return filtered.map(function(v) {
    var dir = v.direction;
    return {
      vdId:      v.vdid || v.id || '',
      roadNo:    v.roadno || '',
      direction: dir === 'N' ? '北上' : dir === 'S' ? '南下' : dir,
      milestone: parseFloat(v.milestone || v.mile || 0) || 0,
      speed:     parseInt(v.speed || 0, 10) || 0,
      volume:    parseInt(v.volume || 0, 10) || 0,
      occupancy: parseFloat(v.occupancy || 0) || 0,
    };
  });
}

function processEvents(items, road) {
  var filtered = items;
  if (road) filtered = filtered.filter(function(e){ return e.roadno === 'N' + road || e.roadno === road; });

  return filtered.map(function(e) {
    var dir = e.direction;
    return {
      roadNo:      e.roadno || '',
      direction:   dir === 'N' ? '北上' : dir === 'S' ? '南下' : dir,
      milestone:   parseFloat(e.milestone || 0) || 0,
      eventType:   e.eventtype || e.type || e.incidenttype || '',
      description: e.description || e.memo || e.comment || '',
      startTime:   e.starttime || '',
      endTime:     e.endtime || '',
      lanes:       e.lanecontrol || e.lane || '',
    };
  });
}

// ── 主處理函式 ────────────────────────────────────────────────
async function handleRequest(request) {
  var url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  var road      = url.searchParams.get('road')      || '';
  var direction = url.searchParams.get('direction') || '';
  var pathname  = url.pathname;

  try {

    // /api/ping
    if (pathname === '/api/ping') {
      return jsonResp({ ok: true, message: '高公局代理運作正常，不需要 API 金鑰', source: BASE });
    }

    // /api/roadlevel — 路段壅塞水準
    if (pathname === '/api/roadlevel') {
      var xml = await fetchXML('/roadwise.xml');
      var items = parseItems(xml, 'Section');
      // 如果沒找到 Section，試試其他常見 tag name
      if (!items.length) items = parseItems(xml, 'LiveTraffic');
      if (!items.length) items = parseItems(xml, 'RoadSection');
      var sections = processRoadLevel(items, road, direction);
      var updateTime = xmlText(xml, 'UpdateTime') || new Date().toISOString();
      return jsonResp({ updateTime: updateTime, count: sections.length, sections: sections,
        _rawTagCount: items.length, _rawSample: items.slice(0,1) });
    }

    // /api/vd — VD 偵測器車速
    if (pathname === '/api/vd') {
      var xml = await fetchXML('/vd_value_summary.xml');
      var items = parseItems(xml, 'VD');
      if (!items.length) items = parseItems(xml, 'VDData');
      var vds = processVD(items, road, direction);
      return jsonResp({ updateTime: xmlText(xml, 'UpdateTime') || new Date().toISOString(),
        count: vds.length, vds: vds, _rawSample: items.slice(0,1) });
    }

    // /api/event — 即時事故施工
    if (pathname === '/api/event') {
      var xml = await fetchXML('/event.xml');
      var items = parseItems(xml, 'Event');
      if (!items.length) items = parseItems(xml, 'Incident');
      var events = processEvents(items, road);
      return jsonResp({ updateTime: xmlText(xml, 'UpdateTime') || new Date().toISOString(),
        count: events.length, events: events });
    }

    // /api/raw — 除錯：看原始 XML（前 3000 字）
    if (pathname === '/api/raw') {
      var path = url.searchParams.get('path') || '/roadwise.xml';
      var xml = await fetchXML(path);
      return new Response(xml.slice(0, 3000), {
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    }

    return jsonResp({ error: '路由不存在。可用：/api/ping /api/roadlevel /api/vd /api/event /api/raw' }, 404);

  } catch(e) {
    return jsonResp({ error: e.message }, 500);
  }
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

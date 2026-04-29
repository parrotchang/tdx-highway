/**
 * Cloudflare Worker — 高公局交通資料庫代理 v4
 * 資料來源：tisvcloud.freeway.gov.tw（免費，不需要 API 金鑰）
 * Worker 負責：
 *   1. 呼叫高公局 XML API
 *   2. 解析 XML → 轉成 JSON
 *   3. 加上 CORS header 回傳給前端
 *
 * 端點：
 *   GET /api/ping          健康檢查
 *   GET /api/roadlevel     路段壅塞水準（即時，每分鐘更新）
 *   GET /api/vd            VD 偵測器即時車速
 *   GET /api/event         即時事故/施工事件
 *   GET /api/section       路段基本資料（靜態）
 */

const BASE = 'https://tisvcloud.freeway.gov.tw/api/v2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── 極簡 XML 解析器（Cloudflare Worker 沒有 DOMParser）────────
// 取出所有 <tag ...>...</tag> 的屬性與文字內容
function parseXMLItems(xml, tagName) {
  const items = [];
  const re = new RegExp(`<${tagName}([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const attrRe = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const obj = {};
    let a;
    while ((a = attrRe.exec(m[1])) !== null) obj[a[1]] = a[2];
    // 取子元素文字
    const inner = m[2];
    const childRe = /<(\w+)[^>]*>([^<]*)<\/\1>/g;
    let c;
    while ((c = childRe.exec(inner)) !== null) obj[c[1]] = c[2].trim();
    items.push(obj);
  }
  return items;
}

// 取 XML 屬性（單一節點）
function xmlAttr(xml, tag, attr) {
  const m = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i').exec(xml);
  return m ? m[1] : null;
}

// 取 XML 文字內容
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
}

// ── 抓高公局 XML ──────────────────────────────────────────────
async function fetchXML(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Accept': 'application/xml, text/xml' },
    cf: { cacheTtl: 55 }, // Cloudflare edge cache 55 秒
  });
  if (!res.ok) throw new Error(`高公局 API 失敗 (${res.status}): ${path}`);
  return res.text();
}

// ── JSON 回應 ─────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ── 路段壅塞水準解析 ─────────────────────────────────────────
// XML 結構: <Section roadno="N1" direction="N" sectionno="..." speed="..." .../>
function parseRoadLevel(xml, road, direction) {
  const sections = parseXMLItems(xml, 'Section');
  let filtered = sections;
  if (road)      filtered = filtered.filter(s => s.roadno === `N${road}` || s.roadno === road);
  if (direction) filtered = filtered.filter(s => s.direction === direction);

  return filtered.map(s => ({
    roadNo:      s.roadno,
    direction:   s.direction === 'N' ? '北上' : s.direction === 'S' ? '南下' : s.direction,
    directionRaw: s.direction,
    sectionNo:   s.sectionno,
    sectionName: s.sectionname || s.name || '',
    startMile:   parseFloat(s.startmile || s.startmilestone || 0),
    endMile:     parseFloat(s.endmile   || s.endmilestone   || 0),
    speed:       parseInt(s.speed || 0, 10),
    travelTime:  parseInt(s.traveltime || 0, 10),
    level:       parseInt(s.levelofservice || s.level || 0, 10),
    updateTime:  s.updatetime || '',
  }));
}

// ── VD 車速解析 ──────────────────────────────────────────────
function parseVD(xml, road, direction) {
  const vds = parseXMLItems(xml, 'VD');
  let filtered = vds;
  if (road)      filtered = filtered.filter(v => v.roadno === `N${road}` || v.roadno === road);
  if (direction) filtered = filtered.filter(v => v.direction === direction);

  return filtered.map(v => ({
    vdId:      v.vdid || v.id || '',
    roadNo:    v.roadno,
    direction: v.direction === 'N' ? '北上' : v.direction === 'S' ? '南下' : v.direction,
    milestone: parseFloat(v.milestone || v.mile || 0),
    speed:     parseInt(v.speed || 0, 10),
    volume:    parseInt(v.volume || 0, 10),
    occupancy: parseFloat(v.occupancy || 0),
    laneCount: parseInt(v.lanecount || 0, 10),
    updateTime: v.updatetime || '',
  }));
}

// ── 事件解析 ─────────────────────────────────────────────────
function parseEvents(xml, road) {
  const events = parseXMLItems(xml, 'Event');
  let filtered = events;
  if (road) filtered = filtered.filter(e => e.roadno === `N${road}` || e.roadno === road);

  return filtered.map(e => ({
    eventId:    e.eventid || e.id || '',
    roadNo:     e.roadno,
    direction:  e.direction === 'N' ? '北上' : e.direction === 'S' ? '南下' : e.direction,
    milestone:  parseFloat(e.milestone || 0),
    eventType:  e.eventtype || e.type || '',
    description: e.description || e.memo || '',
    startTime:  e.starttime || '',
    endTime:    e.endtime || '',
    lanes:      e.lanecontrol || '',
  }));
}

// ── Worker 主體 ───────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const road      = url.searchParams.get('road');      // e.g. "1"
    const direction = url.searchParams.get('direction'); // "N" or "S"

    try {

      // /api/ping
      if (url.pathname === '/api/ping') {
        return json({ ok: true, message: '高公局代理運作正常，不需要 API 金鑰', source: BASE });
      }

      // /api/roadlevel?road=1&direction=N
      // 路段壅塞水準：速度、旅行時間、服務水準
      if (url.pathname === '/api/roadlevel') {
        const xml  = await fetchXML('/roadwise.xml');
        const data = parseRoadLevel(xml, road, direction);
        return json({
          updateTime: xmlText(xml, 'UpdateTime') || new Date().toISOString(),
          count: data.length,
          sections: data,
        });
      }

      // /api/vd?road=1&direction=N
      // VD 偵測器即時車速
      if (url.pathname === '/api/vd') {
        const xml  = await fetchXML('/vd_value_summary.xml');
        const data = parseVD(xml, road, direction);
        return json({
          updateTime: xmlText(xml, 'UpdateTime') || new Date().toISOString(),
          count: data.length,
          vds: data,
        });
      }

      // /api/event?road=1
      // 即時事故/施工/管制事件
      if (url.pathname === '/api/event') {
        const xml  = await fetchXML('/event.xml');
        const data = parseEvents(xml, road);
        return json({
          updateTime: xmlText(xml, 'UpdateTime') || new Date().toISOString(),
          count: data.length,
          events: data,
        });
      }

      // /api/raw?path=/roadwise.xml
      // 除錯用：直接回傳 XML 原文
      if (url.pathname === '/api/raw') {
        const path = url.searchParams.get('path') || '/roadwise.xml';
        const xml  = await fetchXML(path);
        return new Response(xml.slice(0, 4000), {
          headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      return json({ error: '路由不存在。可用路由：/api/ping /api/roadlevel /api/vd /api/event' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
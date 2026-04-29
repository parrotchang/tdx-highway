```javascript
export default {
  async fetch(request, env, ctx) {
    // 1. 處理 CORS，允許你的 GitHub Pages 前端呼叫
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // 實務上可改為你的 GitHub Pages 網址以增加安全性
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 2. 向 TDX 取得 Access Token (使用你在 Cloudflare 設定的環境變數)
      const tokenParams = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.TDX_CLIENT_ID,
        client_secret: env.TDX_CLIENT_SECRET
      });

      const tokenRes = await fetch('[https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token](https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token)', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams
      });
      
      if (!tokenRes.ok) throw new Error("TDX Token 驗證失敗");
      const tokenData = await tokenRes.json();
      const token = tokenData.access_token;

      // 3. 同時抓取路段資料 (Section) 與即時路況 (Live)
      const tdxHeaders = { 
        'Authorization': `Bearer ${token}`, 
        'Accept': 'application/json' 
      };

      const [sectionRes, liveRes] = await Promise.all([
        fetch('[https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Section/Freeway?$format=JSON](https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Section/Freeway?$format=JSON)', { headers: tdxHeaders }),
        fetch('[https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON](https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON)', { headers: tdxHeaders })
      ]);

      const sections = await sectionRes.json();
      const lives = await liveRes.json();

      // 4. 在 Worker 內部合併資料，減輕前端負擔
      const sectionMap = new Map();
      sections.forEach(sec => {
        sectionMap.set(sec.SectionID, { name: sec.SectionName, direction: sec.Direction });
      });

      const combinedData = lives.map(live => {
        const info = sectionMap.get(live.SectionID) || { name: live.SectionID, direction: '未知' };
        return {
          id: live.SectionID,
          name: info.name,
          direction: info.direction,
          speed: live.TravelSpeed
        };
      });

      // 5. 將乾淨的合併資料回傳給前端
      return new Response(JSON.stringify(combinedData), {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          ...corsHeaders
        }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", ...corsHeaders } 
      });
    }
  }
};

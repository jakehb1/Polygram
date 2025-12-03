// api/test.js - Test Polymarket /sports endpoint
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const GAMMA_API = "https://gamma-api.polymarket.com";
  
  const results = {
    ok: true,
    time: new Date().toISOString(),
    env: {
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasSupabaseKey: !!process.env.SUPABASE_SERVICE_KEY,
    },
  };

  // Test /sports endpoint
  try {
    const sportsResp = await fetch(`${GAMMA_API}/sports`);
    results.sportsEndpoint = {
      status: sportsResp.status,
      ok: sportsResp.ok,
    };
    
    if (sportsResp.ok) {
      const sportsData = await sportsResp.json();
      results.sportsEndpoint.dataType = typeof sportsData;
      results.sportsEndpoint.isArray = Array.isArray(sportsData);
      
      if (Array.isArray(sportsData)) {
        results.sportsEndpoint.count = sportsData.length;
        results.sportsEndpoint.sample = sportsData.slice(0, 5);
      } else if (typeof sportsData === 'object') {
        results.sportsEndpoint.keys = Object.keys(sportsData);
        results.sportsEndpoint.rawData = JSON.stringify(sportsData).substring(0, 1000);
      }
    } else {
      const text = await sportsResp.text();
      results.sportsEndpoint.errorText = text.substring(0, 200);
    }
  } catch (e) {
    results.sportsEndpoint = { error: e.message };
  }

  // Test fetching markets with potential sports slugs
  try {
    const patterns = ['nfl', 'nba', 'mlb', 'super-bowl'];
    results.slugSearch = {};
    
    for (const pattern of patterns) {
      const url = `${GAMMA_API}/events?slug=${pattern}&limit=5`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        results.slugSearch[pattern] = {
          found: Array.isArray(data) ? data.length : 0,
          titles: Array.isArray(data) ? data.map(e => e.title || e.slug).slice(0, 3) : [],
        };
      }
    }
  } catch (e) {
    results.slugSearch = { error: e.message };
  }

  // Check all tags
  try {
    const tagsResp = await fetch(`${GAMMA_API}/tags`);
    if (tagsResp.ok) {
      const tags = await tagsResp.json();
      results.tags = {
        total: tags.length,
        list: tags.map(t => ({
          id: t.id,
          slug: t.slug || t.label || t.name,
        })),
      };
    }
  } catch (e) {
    results.tags = { error: e.message };
  }
  
  res.status(200).json(results);
};

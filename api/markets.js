// api/markets.js
// Fetches live markets from Polymarket Gamma API
// Uses /sports endpoint for sports tag IDs

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { kind = "trending", limit = "20" } = req.query;
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const GAMMA_API = "https://gamma-api.polymarket.com";
  
  try {
    let markets = [];
    
    if (kind === "sports") {
      console.log("[markets] Fetching sports via /sports endpoint...");
      
      // Step 1: Get sports metadata from /sports endpoint
      let sportsTagIds = [];
      try {
        const sportsResp = await fetch(`${GAMMA_API}/sports`);
        if (sportsResp.ok) {
          const sportsData = await sportsResp.json();
          console.log("[markets] Sports data:", JSON.stringify(sportsData).substring(0, 500));
          
          // Extract tag IDs from sports data
          if (Array.isArray(sportsData)) {
            for (const sport of sportsData) {
              if (sport.tagId) sportsTagIds.push(sport.tagId);
              if (sport.tag_id) sportsTagIds.push(sport.tag_id);
              if (sport.id) sportsTagIds.push(sport.id);
            }
          } else if (sportsData && typeof sportsData === 'object') {
            // Maybe it's an object with sports as keys
            for (const key of Object.keys(sportsData)) {
              const sport = sportsData[key];
              if (sport && sport.tagId) sportsTagIds.push(sport.tagId);
              if (sport && sport.tag_id) sportsTagIds.push(sport.tag_id);
            }
          }
          console.log("[markets] Sports tag IDs:", sportsTagIds);
        } else {
          console.log("[markets] /sports endpoint returned:", sportsResp.status);
        }
      } catch (e) {
        console.log("[markets] Error fetching /sports:", e.message);
      }
      
      // Step 2: Fetch events for each sports tag
      for (const tagId of sportsTagIds.slice(0, 10)) {
        try {
          const url = `${GAMMA_API}/events?tag_id=${tagId}&closed=false&active=true&limit=50`;
          console.log("[markets] Fetching events for tag:", tagId);
          const resp = await fetch(url);
          if (resp.ok) {
            const events = await resp.json();
            if (Array.isArray(events)) {
              for (const event of events) {
                if (event.markets && Array.isArray(event.markets)) {
                  for (const market of event.markets) {
                    if (!market.closed) {
                      markets.push({
                        ...market,
                        eventTitle: event.title,
                        sportTagId: tagId,
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.log("[markets] Error fetching tag", tagId, e.message);
        }
      }
      
      // Step 3: Also try fetching markets directly with tag IDs
      if (markets.length < 5) {
        for (const tagId of sportsTagIds.slice(0, 5)) {
          try {
            const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&active=true&limit=50`;
            const resp = await fetch(url);
            if (resp.ok) {
              const data = await resp.json();
              if (Array.isArray(data)) {
                markets.push(...data.filter(m => !m.closed));
              }
            }
          } catch (e) {
            console.log("[markets] Error fetching markets for tag", tagId);
          }
        }
      }
      
      // Step 4: Fallback - search by slug pattern
      if (markets.length === 0) {
        console.log("[markets] Trying slug-based search...");
        const sportsSlugPatterns = ['nfl', 'nba', 'mlb', 'nhl', 'ufc', 'soccer', 'tennis'];
        
        for (const pattern of sportsSlugPatterns) {
          try {
            // Try fetching events with slug containing sports keyword
            const url = `${GAMMA_API}/events?closed=false&active=true&limit=100`;
            const resp = await fetch(url);
            if (resp.ok) {
              const events = await resp.json();
              if (Array.isArray(events)) {
                for (const event of events) {
                  const slug = (event.slug || '').toLowerCase();
                  const title = (event.title || '').toLowerCase();
                  
                  if (slug.includes(pattern) || title.includes(pattern)) {
                    if (event.markets && Array.isArray(event.markets)) {
                      for (const market of event.markets) {
                        if (!market.closed) {
                          markets.push({
                            ...market,
                            eventTitle: event.title,
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.log("[markets] Slug search error:", e.message);
          }
          
          if (markets.length > 0) break;
        }
      }
      
      // Remove duplicates
      const seen = new Set();
      markets = markets.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      
      console.log("[markets] Total sports markets found:", markets.length);
      
    } else {
      // Regular fetch for trending/volume/new
      const url = `${GAMMA_API}/markets?closed=false&active=true&limit=100`;
      console.log("[markets] Fetching:", url);
      
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        markets = Array.isArray(data) ? data : [];
      }
    }
    
    console.log("[markets] Raw markets:", markets.length);

    // Filter: must have valid prices
    markets = markets.filter(m => {
      if (!m || m.closed === true) return false;
      
      let prices = m.outcomePrices;
      if (typeof prices === 'string') {
        try { prices = JSON.parse(prices); } catch(e) { return false; }
      }
      if (!prices || !Array.isArray(prices) || prices.length === 0) return false;
      
      const hasValidPrice = prices.some(p => {
        const num = parseFloat(p);
        return !isNaN(num) && num > 0 && num < 1;
      });
      
      return hasValidPrice;
    });

    console.log("[markets] After price filter:", markets.length);

    // Sort by volume (highest first)
    markets.sort((a, b) => {
      const volA = parseFloat(a.volume24hr) || parseFloat(a.volume) || 0;
      const volB = parseFloat(b.volume24hr) || parseFloat(b.volume) || 0;
      return volB - volA;
    });
    
    // For "new", re-sort by date
    if (kind === "new") {
      markets.sort((a, b) => {
        const dateA = new Date(a.createdAt || a.startDate || 0);
        const dateB = new Date(b.createdAt || b.startDate || 0);
        return dateB - dateA;
      });
    }

    // Transform
    const transformed = markets.slice(0, limitNum).map(m => {
      let outcomePrices = m.outcomePrices;
      if (typeof outcomePrices === 'string') {
        try { outcomePrices = JSON.parse(outcomePrices); } catch(e) { outcomePrices = []; }
      }
      outcomePrices = (outcomePrices || []).map(p => parseFloat(p) || 0);
      
      return {
        id: m.id || m.conditionId,
        conditionId: m.conditionId,
        question: m.question || m.eventTitle || "Unknown Market",
        slug: m.slug,
        image: m.image || m.icon,
        volume: parseFloat(m.volume) || 0,
        volume24hr: parseFloat(m.volume24hr) || 0,
        liquidity: parseFloat(m.liquidity) || 0,
        outcomes: m.outcomes || ["Yes", "No"],
        outcomePrices: outcomePrices,
        clobTokenIds: m.clobTokenIds || [],
      };
    });

    console.log("[markets] Returning", transformed.length, "for:", kind);

    return res.status(200).json({ 
      markets: transformed,
      meta: { total: transformed.length, kind }
    });
    
  } catch (err) {
    console.error("[markets] Error:", err.message);
    return res.status(500).json({ 
      error: "fetch_failed", 
      message: err.message,
      markets: [] 
    });
  }
};

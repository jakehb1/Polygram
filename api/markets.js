// api/markets.js
// Fetches live markets from Polymarket Gamma API
// Fetches markets from all categories using /tags endpoint

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
    
    // Map kind to category slug (if it's a category, otherwise it's a sort mode)
    const categoryMap = {
      "sports": ["sports", "nfl", "nba", "mlb", "nhl", "ufc", "soccer", "tennis"],
      "politics": ["politics", "election", "president"],
      "crypto": ["crypto", "bitcoin", "ethereum", "defi"],
      "entertainment": ["entertainment", "movies", "tv", "music"],
      "economics": ["economics", "inflation", "gdp", "fed"],
    };
    
    if (kind === "sports") {
      console.log("[markets] Fetching sports markets from all categories...");
      
      // Get all tags to find sports-related tags
      let allTagIds = [];
      try {
        const tagsResp = await fetch(`${GAMMA_API}/tags`);
        if (tagsResp.ok) {
          const tags = await tagsResp.json();
          if (Array.isArray(tags)) {
            // Filter for sports-related tags
            const sportsKeywords = ["sport", "nfl", "nba", "mlb", "nhl", "ufc", "soccer", "football", "basketball", "baseball", "hockey", "tennis"];
            for (const tag of tags) {
              const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
              if (sportsKeywords.some(keyword => slug.includes(keyword))) {
                if (tag.id) allTagIds.push(tag.id);
              }
            }
            console.log("[markets] Found sports tag IDs:", allTagIds.length);
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching tags:", e.message);
      }
      
      // Fetch markets for each sports tag
      for (const tagId of allTagIds.slice(0, 15)) {
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
          console.log("[markets] Error fetching markets for tag", tagId, e.message);
        }
      }
      
      // Also try /sports endpoint as fallback
      if (markets.length < 10) {
        try {
          const sportsResp = await fetch(`${GAMMA_API}/sports`);
          if (sportsResp.ok) {
            const sportsData = await sportsResp.json();
            let sportsTagIds = [];
            
            if (Array.isArray(sportsData)) {
              for (const sport of sportsData) {
                if (sport.tagId) sportsTagIds.push(sport.tagId);
                if (sport.tag_id) sportsTagIds.push(sport.tag_id);
                if (sport.id) sportsTagIds.push(sport.id);
              }
            } else if (sportsData && typeof sportsData === 'object') {
              for (const key of Object.keys(sportsData)) {
                const sport = sportsData[key];
                if (sport && sport.tagId) sportsTagIds.push(sport.tagId);
                if (sport && sport.tag_id) sportsTagIds.push(sport.tag_id);
              }
            }
            
            for (const tagId of sportsTagIds.slice(0, 10)) {
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
                console.log("[markets] Error fetching markets for sports tag", tagId);
              }
            }
          }
        } catch (e) {
          console.log("[markets] Error fetching /sports:", e.message);
        }
      }
      
    } else {
      // For trending/volume/new: fetch markets from ALL categories
      console.log("[markets] Fetching markets from all categories for:", kind);
      
      // Step 1: Get all available tags/categories
      let allTagIds = [];
      try {
        const tagsResp = await fetch(`${GAMMA_API}/tags`);
        if (tagsResp.ok) {
          const tags = await tagsResp.json();
          if (Array.isArray(tags)) {
            // Get all tag IDs (limit to top 20 most popular categories to avoid too many requests)
            allTagIds = tags
              .filter(tag => tag.id)
              .map(tag => tag.id)
              .slice(0, 20);
            console.log("[markets] Found", allTagIds.length, "categories to fetch from");
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching tags:", e.message);
      }
      
      // Step 2: Fetch markets from each category
      const fetchPromises = allTagIds.map(async (tagId) => {
        try {
          const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&active=true&limit=30`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json();
            return Array.isArray(data) ? data.filter(m => !m.closed) : [];
          }
          return [];
        } catch (e) {
          console.log("[markets] Error fetching markets for tag", tagId, e.message);
          return [];
        }
      });
      
      // Wait for all category fetches to complete
      const categoryResults = await Promise.all(fetchPromises);
      markets = categoryResults.flat();
      
      // Also fetch general markets endpoint as a fallback to ensure we get all markets
      try {
        const url = `${GAMMA_API}/markets?closed=false&active=true&limit=100`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data)) {
            markets.push(...data.filter(m => !m.closed));
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching general markets:", e.message);
      }
    }
    
    // Remove duplicates by market ID
    const seen = new Set();
    markets = markets.filter(m => {
      const id = m.id || m.conditionId;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    
    console.log("[markets] Total unique markets found:", markets.length);

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

// api/markets.js
// Fetches live markets from Polymarket Gamma API
// Fetches markets from all categories using /tags endpoint

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { kind = "trending", limit = "1000", sportType = null } = req.query;
  // Allow much higher limits to get all markets (default 1000, max 10000)
  const limitNum = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
  // Parse minVolume - default to 0 to get ALL markets (no volume filter by default)
  const minVolumeProvided = req.query.minVolume !== undefined && req.query.minVolume !== null;
  const minVolumeParsed = minVolumeProvided ? Number(req.query.minVolume) : 0;
  const minVolumeNum = Math.max(isNaN(minVolumeParsed) ? 0 : minVolumeParsed, 0);
  // sportType: "games" or "props" - used to filter sports markets

  const GAMMA_API = "https://gamma-api.polymarket.com";
  
  try {
    let markets = [];
    
    // Check if kind is a category (not a sort mode like trending/volume/new)
    const sortModes = ["trending", "volume", "new", "breaking"];
    const isCategory = !sortModes.includes(kind);
    
    // Check if this is a sports subcategory (like nfl, nba, etc.)
    const sportsSubcategories = ["nfl", "nba", "mlb", "nhl", "wnba", "ufc", "soccer", "football", 
                                 "basketball", "baseball", "hockey", "tennis", "cricket", "golf", 
                                 "boxing", "formula", "f1", "epl", "cbb", "cfb"];
    const isSportsSubcategory = sportsSubcategories.includes(kind.toLowerCase());
    
    if (isCategory && kind !== "sports" && !isSportsSubcategory) {
      // Fetch markets for a specific category
      console.log("[markets] Fetching markets for category:", kind);
      
      // Get tag ID for this category
      let categoryTagId = null;
      try {
        const tagsResp = await fetch(`${GAMMA_API}/tags`);
        if (tagsResp.ok) {
          const tags = await tagsResp.json();
          if (Array.isArray(tags)) {
            // Find tag matching the category slug
            const categoryTag = tags.find(tag => {
              const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
              return slug === kind.toLowerCase() || slug.includes(kind.toLowerCase());
            });
            if (categoryTag && categoryTag.id) {
              categoryTagId = categoryTag.id;
              console.log("[markets] Found tag ID for category:", categoryTagId);
            }
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching tags for category:", e.message);
      }
      
      // Fetch markets for this category with higher limit
      if (categoryTagId) {
        try {
          // Fetch with high limit to get all markets in this category
          const url = `${GAMMA_API}/markets?tag_id=${categoryTagId}&closed=false&active=true&limit=1000`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data)) {
              markets = data.filter(m => !m.closed && m.active !== false);
            }
          }
        } catch (e) {
          console.log("[markets] Error fetching category markets:", e.message);
        }
      }
      
      // Also fetch general markets to ensure we get all markets in this category
      try {
        const url = `${GAMMA_API}/markets?closed=false&active=true&limit=1000`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data)) {
            // Filter by category if we have a tag ID
            if (categoryTagId) {
              // Check if market has this tag
              const categoryMarkets = data.filter(m => {
                if (m.closed || m.active === false) return false;
                // Check if market has matching tag_id in its tags array or tagId field
                const marketTags = m.tags || m.tagIds || [];
                return Array.isArray(marketTags) && marketTags.includes(categoryTagId) ||
                       m.tagId === categoryTagId || m.tag_id === categoryTagId;
              });
              markets.push(...categoryMarkets);
            } else {
              // No specific category, add all active markets
              markets.push(...data.filter(m => !m.closed && m.active !== false));
            }
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching general markets:", e.message);
      }
      
    } else if (isSportsSubcategory) {
      // Fetch game events for a specific sports subcategory (NFL, NBA, etc.)
      const isGamesOnly = sportType === "games";
      console.log("[markets] Fetching for sports subcategory:", kind, "sportType:", sportType, "gamesOnly:", isGamesOnly);
      
      // Map sport slugs to common variations for better matching
      const sportVariations = {
        'nfl': ['nfl', 'american football', 'football'],
        'nba': ['nba', 'basketball'],
        'mlb': ['mlb', 'baseball'],
        'nhl': ['nhl', 'hockey'],
        'cfb': ['cfb', 'college football', 'ncaaf'],
        'cbb': ['cbb', 'college basketball', 'ncaab'],
        'epl': ['epl', 'premier league', 'english premier league'],
      };
      
      const searchTerms = sportVariations[kind.toLowerCase()] || [kind.toLowerCase()];
      
      // Strategy 1: Fetch events directly (this gives us game structure)
      try {
        const eventsUrl = `${GAMMA_API}/events?closed=false&active=true&limit=1000`;
        const eventsResp = await fetch(eventsUrl);
        if (eventsResp.ok) {
          const events = await eventsResp.json();
          if (Array.isArray(events)) {
            console.log("[markets] Fetched", events.length, "total events");
            
            // Filter events by sport keyword - check tags, slug, title, and ticker
            for (const event of events) {
              const eventSlug = (event.slug || "").toLowerCase();
              const eventTitle = (event.title || "").toLowerCase();
              const eventTicker = (event.ticker || "").toLowerCase();
              
              // Check event tags for sport match
              const eventTags = event.tags || [];
              const tagMatches = Array.isArray(eventTags) && eventTags.some(tag => {
                const tagSlug = (tag.slug || tag.label || "").toLowerCase();
                return searchTerms.some(term => tagSlug.includes(term) || term.includes(tagSlug));
              });
              
              // Check if event matches any of our search terms in slug/title/ticker
              const textMatches = searchTerms.some(term => 
                eventSlug.includes(term) || 
                eventTitle.includes(term) ||
                eventTicker.includes(term)
              );
              
              // Match if either tags or text match
              const matches = tagMatches || textMatches;
              
              // For games only, skip obvious prop/future events
              if (isGamesOnly && matches) {
                const eventTitleLower = eventTitle;
                // Skip obvious prop/future events (but don't skip if we're not sure)
                const isDefinitelyProp = 
                  eventTitleLower.includes("mvp") ||
                  eventTitleLower.includes("leader") ||
                  eventTitleLower.includes("champion") && !eventTitleLower.includes("week") ||
                  eventTitleLower.includes("award") ||
                  eventTitleLower.includes("winner") && !eventTitleLower.includes("week");
                
                if (isDefinitelyProp) {
                  continue;
                }
              }
              
              if (matches && event.markets && Array.isArray(event.markets)) {
                // For games only, check if this event has any game-like markets
                // Be less strict - include events that might have games
                if (isGamesOnly) {
                  // Check if this event has ANY markets that could be games
                  // Don't be too strict - include if it has markets that aren't clearly props
                  const hasPotentialGameMarkets = event.markets.some(m => {
                    const question = (m.question || "").toLowerCase();
                    const slug = (m.slug || "").toLowerCase();
                    
                    // Skip if it's clearly a prop
                    const isDefinitelyProp = 
                      question.includes("will ") && (question.includes("leader") || question.includes("mvp") || question.includes("award")) ||
                      question.includes("leader") ||
                      question.includes("mvp") ||
                      question.includes("award") ||
                      question.includes("champion") && !question.includes("week") ||
                      slug.includes("prop") && slug.includes("leader");
                    
                    // If it's not clearly a prop, include it
                    return !isDefinitelyProp;
                  });
                  
                  // Only skip if ALL markets are clearly props
                  if (!hasPotentialGameMarkets) {
                    continue;
                  }
                }
                
                // Extract all markets from this event (game)
                for (const market of event.markets) {
                  if (!market.closed && market.active !== false) {
                    // For games only, filter out prop markets - be very strict
                    if (isGamesOnly) {
                      const question = (market.question || "").toLowerCase();
                      const slug = (market.slug || "").toLowerCase();
                      
                      // Exclude only clearly prop markets (be less strict - include more)
                      const isDefinitelyProp = 
                        (question.includes("will ") && (question.includes("leader") || question.includes("mvp") || question.includes("award"))) ||
                        question.includes("leader") ||
                        question.includes("mvp") ||
                        question.includes("award") ||
                        (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
                        (question.includes("winner") && !question.includes("week") && !question.includes("vs") && !question.includes("moneyline")) ||
                        (slug.includes("prop") && (slug.includes("leader") || slug.includes("mvp")));
                      
                      // Include everything else (games, spreads, totals, moneyline, etc.)
                      if (isDefinitelyProp) {
                        continue;
                      }
                    }
                    
                    // Avoid duplicates
                    const existing = markets.find(m => m.id === market.id);
                    if (!existing) {
                      markets.push({
                        ...market,
                        eventId: event.id,
                        eventTitle: event.title,
                        eventSlug: event.slug,
                        eventTicker: event.ticker,
                        eventStartDate: event.startDate,
                        eventEndDate: event.endDate,
                        eventImage: event.image || event.icon,
                        eventVolume: event.volume,
                        eventLiquidity: event.liquidity,
                        // Include event tags for week filtering
                        eventTags: event.tags || [],
                      });
                    }
                  }
                }
              }
            }
            console.log("[markets] Found", markets.length, "markets from events");
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching events:", e.message);
      }
      
      // Strategy 2: Get tag ID and fetch events by tag
      let categoryTagId = null;
      try {
        const tagsResp = await fetch(`${GAMMA_API}/tags`);
        if (tagsResp.ok) {
          const tags = await tagsResp.json();
          if (Array.isArray(tags)) {
            // Find tag matching the sports subcategory
            const categoryTag = tags.find(tag => {
              const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
              return searchTerms.some(term => slug === term || slug.includes(term));
            });
            if (categoryTag && categoryTag.id) {
              categoryTagId = categoryTag.id;
              console.log("[markets] Found tag ID for sports subcategory:", categoryTagId);
              
              // Note: events API might not support tag_id parameter
              // We'll rely on Strategy 1 which checks event tags
              console.log("[markets] Tag ID found, but events API may not support tag_id filter");
            }
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching tags:", e.message);
      }
      
      // Strategy 3: Fetch markets directly by tag IDs, then match to events for games
      if (categoryTagIds.length > 0 || categoryTagId) {
        // Use all tag IDs from /sports endpoint, or fallback to single tag ID
        const tagIdsToUse = categoryTagIds.length > 0 ? categoryTagIds : [categoryTagId];
        
        // Fetch markets for each tag ID
        const marketFetchPromises = tagIdsToUse.map(async (tagId) => {
          try {
            const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&active=true&limit=1000`;
            const resp = await fetch(url);
            if (resp.ok) {
              const data = await resp.json();
              if (Array.isArray(data)) {
                return data.filter(m => !m.closed && m.active !== false);
              }
            }
            return [];
          } catch (e) {
            console.log("[markets] Error fetching markets for tag", tagId, e.message);
            return [];
          }
        });
        
        try {
          const marketArrays = await Promise.all(marketFetchPromises);
          const newMarkets = marketArrays.flat();
          console.log("[markets] Fetched", newMarkets.length, "markets from tag IDs:", tagIdsToUse);
          
          if (newMarkets.length > 0) {
            if (isGamesOnly) {
              // For games: fetch all events and match markets to events
              // Markets that belong to events are game markets
              try {
                const allEventsUrl = `${GAMMA_API}/events?closed=false&active=true&limit=1000`;
                const allEventsResp = await fetch(allEventsUrl);
                if (allEventsResp.ok) {
                  const allEvents = await allEventsResp.json();
                  if (Array.isArray(allEvents)) {
                    // Create a map of market IDs to events
                    const marketIdToEvent = new Map();
                    for (const event of allEvents) {
                      if (event.markets && Array.isArray(event.markets)) {
                        for (const eventMarket of event.markets) {
                          const marketId = eventMarket.id || eventMarket.conditionId;
                          if (marketId) {
                            marketIdToEvent.set(marketId, event);
                          }
                        }
                      }
                    }
                    
                    // Only add markets that belong to events
                    let addedCount = 0;
                    for (const market of newMarkets) {
                      const marketId = market.id || market.conditionId;
                      const existing = markets.find(m => (m.id || m.conditionId) === marketId);
                      if (!existing && marketIdToEvent.has(marketId)) {
                        const event = marketIdToEvent.get(marketId);
                        const question = (market.question || "").toLowerCase();
                        
                        // Exclude only clearly prop markets (be less strict)
                        const slug = (market.slug || "").toLowerCase();
                        const isDefinitelyProp = 
                          (question.includes("will ") && (question.includes("leader") || question.includes("mvp") || question.includes("award"))) ||
                          question.includes("leader") ||
                          question.includes("mvp") ||
                          question.includes("award") ||
                          (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
                          (question.includes("winner") && !question.includes("week") && !question.includes("vs") && !question.includes("moneyline")) ||
                          (slug.includes("prop") && (slug.includes("leader") || slug.includes("mvp")));
                        
                        if (!isDefinitelyProp) {
                          markets.push({
                            ...market,
                            eventId: event.id,
                            eventTitle: event.title,
                            eventSlug: event.slug,
                            eventTicker: event.ticker,
                            eventStartDate: event.startDate,
                            eventEndDate: event.endDate,
                            eventImage: event.image || event.icon,
                            eventVolume: event.volume,
                            eventLiquidity: event.liquidity,
                            eventTags: event.tags || [],
                          });
                          addedCount++;
                        }
                      }
                    }
                    console.log("[markets] Added", addedCount, "game markets matched to events (total:", markets.length, ")");
                  }
                }
              } catch (e) {
                console.log("[markets] Error matching markets to events:", e.message);
              }
            } else {
              // For props or all markets, include everything
              for (const market of newMarkets) {
                const existing = markets.find(m => m.id === market.id);
                if (!existing) {
                  markets.push(market);
                }
              }
              console.log("[markets] Added", newMarkets.length, "markets from direct fetch");
            }
          }
        } catch (e) {
          console.log("[markets] Error processing markets from tag IDs:", e.message);
        }
      }
      
    } else if (kind === "sports") {
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
      
      // Fetch markets for each sports tag (prioritize live/active markets)
      for (const tagId of allTagIds.slice(0, 15)) {
        try {
          // Try fetching live markets first
          const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&active=true&limit=50`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data)) {
              // Filter for active, non-closed markets
              const activeMarkets = data.filter(m => !m.closed && m.active !== false);
              markets.push(...activeMarkets);
            }
          }
        } catch (e) {
          console.log("[markets] Error fetching markets for tag", tagId, e.message);
        }
      }
      
      // Also try fetching from events endpoint for live sports events
      try {
        const eventsUrl = `${GAMMA_API}/events?closed=false&active=true&limit=100`;
        const eventsResp = await fetch(eventsUrl);
        if (eventsResp.ok) {
          const events = await eventsResp.json();
          if (Array.isArray(events)) {
            // Filter for sports-related events and extract their markets
            const sportsKeywords = ["nfl", "nba", "mlb", "nhl", "ufc", "soccer", "football", "basketball", "baseball", "hockey", "tennis", "cricket", "golf", "boxing", "formula"];
            for (const event of events) {
              const eventSlug = (event.slug || "").toLowerCase();
              const eventTitle = (event.title || "").toLowerCase();
              
              if (sportsKeywords.some(keyword => eventSlug.includes(keyword) || eventTitle.includes(keyword))) {
                if (event.markets && Array.isArray(event.markets)) {
                  for (const market of event.markets) {
                    if (!market.closed && market.active !== false) {
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
        console.log("[markets] Error fetching sports events:", e.message);
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
                if (sport && sport.id) sportsTagIds.push(sport.id);
              }
            }
            
            for (const tagId of sportsTagIds.slice(0, 10)) {
              try {
                const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&active=true&limit=50`;
                const resp = await fetch(url);
                if (resp.ok) {
                  const data = await resp.json();
                  if (Array.isArray(data)) {
                    // Filter for active, non-closed markets
                    const activeMarkets = data.filter(m => !m.closed && m.active !== false);
                    markets.push(...activeMarkets);
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
      
      // For trending/volume/new: fetch ALL active markets from the main endpoint
      // This ensures we get a comprehensive 1:1 match with Polymarket
      try {
        // Fetch all active markets with high limit
        const url = `${GAMMA_API}/markets?closed=false&active=true&limit=10000`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data)) {
            markets = data.filter(m => !m.closed && m.active !== false);
            console.log("[markets] Fetched", markets.length, "markets from main endpoint");
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching all markets:", e.message);
      }
      
      // Also fetch from events endpoint to get event-based markets (sports games, etc.)
      try {
        const eventsUrl = `${GAMMA_API}/events?closed=false&active=true&limit=1000`;
        const eventsResp = await fetch(eventsUrl);
        if (eventsResp.ok) {
          const events = await eventsResp.json();
          if (Array.isArray(events)) {
            for (const event of events) {
              if (event.markets && Array.isArray(event.markets)) {
                for (const market of event.markets) {
                  if (!market.closed && market.active !== false) {
                    const existing = markets.find(m => (m.id || m.conditionId) === (market.id || market.conditionId));
                    if (!existing) {
                      markets.push({
                        ...market,
                        eventId: event.id,
                        eventTitle: event.title,
                        eventSlug: event.slug,
                        eventTicker: event.ticker,
                        eventStartDate: event.startDate,
                        eventEndDate: event.endDate,
                        eventImage: event.image || event.icon,
                        eventVolume: event.volume,
                        eventLiquidity: event.liquidity,
                      });
                    }
                  }
                }
              }
            }
            console.log("[markets] Added markets from events, total:", markets.length);
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching events:", e.message);
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

    // Filter: If sportType is "games", only include markets that are part of events (actual games)
    // Exclude props, futures, and other non-game markets
    if (sportType === "games" && isSportsSubcategory) {
      const beforeFilter = markets.length;
      markets = markets.filter(m => {
        // Must have eventId (part of an actual game event)
        if (!m.eventId && !m.eventTitle && !m.eventSlug && !m.eventTicker) {
          return false;
        }
        
        // Less strict filtering - exclude only clearly prop markets
        const question = (m.question || "").toLowerCase();
        const slug = (m.slug || "").toLowerCase();
        
        // Exclude only clearly prop markets (leader, MVP, award markets)
        const isDefinitelyProp = 
          (question.includes("will ") && (question.includes("leader") || question.includes("mvp") || question.includes("award"))) ||
          question.includes("leader") ||
          question.includes("mvp") ||
          question.includes("award") ||
          (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
          (question.includes("winner") && !question.includes("week") && !question.includes("vs") && !question.includes("moneyline")) ||
          (slug.includes("prop") && (slug.includes("leader") || slug.includes("mvp")));
        
        // Include everything else (games, spreads, totals, moneyline, etc.)
        return !isDefinitelyProp;
      });
      console.log("[markets] After games-only filter:", markets.length, "(removed", beforeFilter - markets.length, "non-game markets)");
    }

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

    // Filter: must meet minimum volume threshold (only if minVolumeNum > 0)
    if (minVolumeNum > 0) {
      markets = markets.filter(m => {
        const volume24hr = parseFloat(m.volume24hr) || 0;
        const volume = parseFloat(m.volume) || 0;
        const totalVolume = Math.max(volume24hr, volume);
        return totalVolume >= minVolumeNum;
      });
      console.log("[markets] After volume filter (min: $" + minVolumeNum + "):", markets.length);
    } else {
      console.log("[markets] No volume filter applied, keeping all", markets.length, "markets");
    }

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
      
      // Parse outcomes - can be string or array
      let outcomes = m.outcomes || ["Yes", "No"];
      if (typeof outcomes === 'string') {
        try { outcomes = JSON.parse(outcomes); } catch(e) { 
          // If parsing fails, try splitting by comma
          outcomes = outcomes.split(',').map(o => o.trim()).filter(o => o);
        }
      }
      if (!Array.isArray(outcomes) || outcomes.length === 0) {
        outcomes = ["Yes", "No"];
      }
      
      return {
        id: m.id || m.conditionId,
        conditionId: m.conditionId,
        question: m.question || m.eventTitle || "Unknown Market",
        slug: m.slug,
        image: m.image || m.icon || m.eventImage,
        volume: parseFloat(m.volume) || 0,
        volume24hr: parseFloat(m.volume24hr) || 0,
        liquidity: parseFloat(m.liquidity) || 0,
        outcomes: outcomes,
        outcomePrices: outcomePrices,
        clobTokenIds: m.clobTokenIds || [],
        // Event/game information for sports markets
        eventId: m.eventId,
        eventTitle: m.eventTitle,
        eventSlug: m.eventSlug,
        eventTicker: m.eventTicker,
        eventStartDate: m.eventStartDate,
        eventEndDate: m.eventEndDate,
        eventImage: m.eventImage,
        eventVolume: m.eventVolume ? parseFloat(m.eventVolume) : 0,
        eventLiquidity: m.eventLiquidity ? parseFloat(m.eventLiquidity) : 0,
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

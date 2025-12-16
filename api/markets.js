// api/markets.js
// Fetches markets from Supabase database (mimics Polymarket architecture)
// Falls back to Polymarket Gamma API if database is not configured or empty

// Simple in-memory cache with TTL (5 seconds for fast updates)
const cache = new Map();
const CACHE_TTL = 5000; // 5 seconds

// Category tag IDs (verified from Polymarket events)
const CATEGORY_TAG_IDS = {
  'politics': 2,
  'finance': 120,
  'crypto': 21,
  'sports': 1,
  'tech': 1401,
  'geopolitics': 100265,
  'culture': 596,
  'world': 101970,
  'economy': 100328,
  'elections': 377,
};

function getCacheKey(kind, sportType, platform = 'polymarket') {
  return `${platform}_${kind}_${sportType || 'all'}`;
}

function getCached(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  // Clean up old cache entries (keep only last 10)
  if (cache.size > 10) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { kind = "trending", limit = "1000", sportType = null, platform = "polymarket" } = req.query;
  
  // Route to appropriate platform handler
  const platformLower = (platform || "polymarket").toLowerCase();
  
  if (platformLower === "kalshi") {
    // Handle Kalshi requests
    try {
      const { fetchKalshiMarkets } = require("./kalshi-markets");
      const markets = await fetchKalshiMarkets({
        kind,
        limit: Math.min(Math.max(Number(limit) || 1000, 1), 10000),
        sportType,
      });
      
      return res.status(200).json({
        markets: markets,
        meta: { total: markets.length, kind, platform: "kalshi" },
      });
    } catch (error) {
      console.error("[markets] Kalshi error:", error.message);
      return res.status(500).json({
        error: "kalshi_fetch_failed",
        message: error.message,
        markets: [],
      });
    }
  }
  
  // Default to Polymarket (existing logic continues below)
  // Allow much higher limits to get all markets (default 1000, max 10000)
  const limitNum = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
  // Parse minVolume - default to $0.01 to filter out zero-volume markets but allow very low volume
  // This ensures we get live markets even if they have minimal volume
  const minVolumeProvided = req.query.minVolume !== undefined && req.query.minVolume !== null;
  const minVolumeParsed = minVolumeProvided ? Number(req.query.minVolume) : 0.01;
  const minVolumeNum = Math.max(isNaN(minVolumeParsed) ? 0.01 : minVolumeParsed, 0);
  // sportType: "games" or "props" - used to filter sports markets

  // Check cache first (only for reasonable limits to avoid caching huge responses)
  if (limitNum <= 1000 && platformLower === "polymarket") {
    const cacheKey = getCacheKey(kind, sportType, platformLower);
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[markets] Returning cached data for:", cacheKey);
      return res.status(200).json(cached);
    }
  }

  const GAMMA_API = "https://gamma-api.polymarket.com";
  
  // Helper function to extract week number from text
  function extractWeekNumber(text) {
    if (!text) return null;
    const weekMatch = text.match(/week\s*(\d+)/i);
    return weekMatch ? parseInt(weekMatch[1], 10) : null;
  }
  
  // Helper function to determine current NFL week (approximate)
  // NFL season typically starts early September, 18 weeks regular season
  function getCurrentNFLWeek() {
    const now = new Date();
    const currentYear = now.getFullYear();
    // NFL season typically starts first Thursday of September
    // Approximate: September 5-12 is usually Week 1
    const seasonStart = new Date(currentYear, 8, 5); // September 5
    const daysSinceStart = Math.floor((now - seasonStart) / (1000 * 60 * 60 * 24));
    const week = Math.floor(daysSinceStart / 7) + 1;
    // Clamp to reasonable range (1-18 for regular season, up to 22 for playoffs)
    return Math.max(1, Math.min(22, week));
  }
  
  // Define current date and week at function level so they're available everywhere
  const now = new Date();
  const currentWeek = getCurrentNFLWeek();
  
  try {
    let markets = [];
    
    // Check if kind is a category (not a sort mode like trending/volume/new)
    const sortModes = ["trending", "volume", "new", "breaking"];
    const isCategory = !sortModes.includes(kind);
    
    // Check if this is a sports subcategory - only NFL for now
    const sportsSubcategories = ["nfl"];
    const isSportsSubcategory = sportsSubcategories.includes(kind.toLowerCase());
    
    // Try to fetch from Supabase database first (mimics Polymarket architecture)
    let useDatabase = false;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const { createClient } = require("@supabase/supabase-js");
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );
        
        // Check if we have markets in database (synced within last 5 minutes)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        
        if (isCategory && !isSportsSubcategory) {
          // Fetch from database by category
          const categoryTagId = CATEGORY_TAG_IDS[kind.toLowerCase()];
          if (categoryTagId) {
            const { data: dbMarkets, error } = await supabase
              .from('markets')
              .select('*')
              .eq('category', kind.toLowerCase())
              .eq('active', true)
              .eq('closed', false)
              .gte('synced_at', fiveMinutesAgo)
              .order('volume_24hr', { ascending: false })
              .limit(limitNum);
            
            if (!error && dbMarkets && dbMarkets.length > 0) {
              console.log(`[markets] Serving ${dbMarkets.length} markets from database for ${kind}`);
              // Transform database format to API format
              markets = dbMarkets.map(m => ({
                id: m.id,
                conditionId: m.condition_id,
                question: m.question,
                slug: m.slug,
                description: m.description,
                image: m.image,
                icon: m.icon,
                outcomes: m.outcomes || [],
                outcomePrices: m.outcome_prices || [],
                volume: m.volume,
                volume24hr: m.volume_24hr,
                volume1wk: m.volume_1wk,
                liquidity: m.liquidity,
                active: m.active,
                closed: m.closed,
                resolved: m.resolved,
                eventId: m.event_id,
                eventTitle: m.event_title,
                eventSlug: m.event_slug,
                eventImage: m.event_image,
                eventStartDate: m.event_start_date,
                eventEndDate: m.event_end_date,
                eventTags: m.event_tags || [],
                resolutionSource: m.resolution_source,
                endDate: m.end_date,
                startDate: m.start_date,
                createdAt: m.created_at_pm,
                updatedAt: m.updated_at_pm
              }));
              useDatabase = true;
            }
          }
        } else if (isSportsSubcategory && kind.toLowerCase() === 'nfl') {
          // Fetch NFL markets from database
          const { data: dbMarkets, error } = await supabase
            .from('markets')
            .select('*')
            .eq('category', 'sports')
            .eq('active', true)
            .eq('closed', false)
            .gte('synced_at', fiveMinutesAgo)
            .order('volume_24hr', { ascending: false })
            .limit(limitNum);
          
          if (!error && dbMarkets && dbMarkets.length > 0) {
            // Filter for NFL games (check event tags or question)
            const nflMarkets = dbMarkets.filter(m => {
              const tags = m.event_tags || [];
              const hasNFLTag = tags.some(t => {
                const tagId = typeof t === 'object' ? t.id : t;
                return [1, 450, 100639].includes(Number(tagId)); // NFL tag IDs
              });
              return hasNFLTag;
            });
            
            if (nflMarkets.length > 0) {
              console.log(`[markets] Serving ${nflMarkets.length} NFL markets from database`);
              markets = nflMarkets.map(m => ({
                id: m.id,
                conditionId: m.condition_id,
                question: m.question,
                slug: m.slug,
                description: m.description,
                image: m.image,
                icon: m.icon,
                outcomes: m.outcomes || [],
                outcomePrices: m.outcome_prices || [],
                volume: m.volume,
                volume24hr: m.volume_24hr,
                volume1wk: m.volume_1wk,
                liquidity: m.liquidity,
                active: m.active,
                closed: m.closed,
                resolved: m.resolved,
                eventId: m.event_id,
                eventTitle: m.event_title,
                eventSlug: m.event_slug,
                eventImage: m.event_image,
                eventStartDate: m.event_start_date,
                eventEndDate: m.event_end_date,
                eventTags: m.event_tags || [],
                resolutionSource: m.resolution_source,
                endDate: m.end_date,
                startDate: m.start_date,
                createdAt: m.created_at_pm,
                updatedAt: m.updated_at_pm
              }));
              useDatabase = true;
            }
          }
        }
      } catch (dbError) {
        console.log("[markets] Database fetch failed, falling back to API:", dbError.message);
        useDatabase = false;
      }
    }
    
    // If database fetch succeeded, apply filters and return
    if (useDatabase && markets.length > 0) {
      // Apply same filters as API path
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
      
      // Filter: must meet minimum volume threshold
      const beforeVolumeFilter = markets.length;
      markets = markets.filter(m => {
        const volume24hr = parseFloat(m.volume24hr) || 0;
        const volume = parseFloat(m.volume) || 0;
        const totalVolume = Math.max(volume24hr, volume);
        return totalVolume > 0 && totalVolume >= minVolumeNum;
      });
      console.log("[markets] After volume filter (min: $" + minVolumeNum + "):", markets.length, "(removed", beforeVolumeFilter - markets.length, "zero/low-volume markets)");
      
      // Sort by volume (highest first)
      markets.sort((a, b) => {
        const volA = parseFloat(a.volume24hr) || parseFloat(a.volume) || 0;
        const volB = parseFloat(b.volume24hr) || parseFloat(b.volume) || 0;
        return volB - volA;
      });
      
      // Transform and return (same as API path)
      const transformed = markets.slice(0, limitNum).map(m => {
        let outcomePrices = m.outcomePrices;
        if (typeof outcomePrices === 'string') {
          try { outcomePrices = JSON.parse(outcomePrices); } catch(e) { outcomePrices = []; }
        }
        outcomePrices = (outcomePrices || []).map(p => parseFloat(p) || 0);
        
        let outcomes = m.outcomes || ["Yes", "No"];
        if (typeof outcomes === 'string') {
          try { outcomes = JSON.parse(outcomes); } catch(e) { 
            outcomes = outcomes.split(',').map(o => o.trim()).filter(o => o);
          }
        }
        if (!Array.isArray(outcomes) || outcomes.length === 0) {
          outcomes = ["Yes", "No"];
        }
        
        return {
          id: m.id,
          conditionId: m.conditionId,
          question: m.question,
          slug: m.slug,
          description: m.description,
          image: m.image || m.eventImage,
          icon: m.icon,
          outcomes: outcomes,
          outcomePrices: outcomePrices,
          volume: m.volume || 0,
          volume24hr: m.volume24hr || 0,
          volume1wk: m.volume1wk || 0,
          liquidity: m.liquidity || 0,
          active: m.active !== false,
          closed: m.closed || false,
          resolved: m.resolved || false,
          eventId: m.eventId,
          eventTitle: m.eventTitle,
          eventSlug: m.eventSlug,
          eventImage: m.eventImage,
          eventStartDate: m.eventStartDate,
          eventEndDate: m.eventEndDate,
          eventTags: m.eventTags || [],
          resolutionSource: m.resolutionSource,
          endDate: m.endDate,
          startDate: m.startDate,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        };
      });
      
      const response = {
        markets: transformed,
        meta: { total: transformed.length, kind, source: 'database' }
      };
      
      // Cache the response
      if (limitNum <= 1000) {
        const cacheKey = getCacheKey(kind, sportType);
        setCache(cacheKey, response);
      }
      
      return res.status(200).json(response);
    }
    
    // If database fetch failed or returned no results, fall back to direct API
    if (!useDatabase || markets.length === 0) {
      console.log("[markets] Fetching from Polymarket API (database not available or empty)");
      
      const GAMMA_API = "https://gamma-api.polymarket.com";
      
      if (isCategory && kind !== "sports" && !isSportsSubcategory) {
      // Fetch markets for a specific category (Finance, Politics, Crypto, etc.)
      // Match Polymarket exactly by using their tag IDs
      console.log("[markets] Fetching markets for category:", kind);
      
      // Get tag IDs for this category - tags are on EVENTS, not markets directly
      // Polymarket structure: Events have tags, markets are nested in events
      let categoryTagIds = [];
      let categoryTagId = null;
      
      // Known tag IDs from Polymarket (verified from events - these are the actual tag IDs used)
      // These match exactly what Polymarket uses in their events
      const knownTagIds = {
        'politics': 2,           // Politics - 267 events
        'finance': 120,          // Finance - 22 events
        'crypto': 21,            // Crypto - 59 events
        'sports': 1,             // Sports - 47 events
        'tech': 1401,           // Tech - 49 events
        'geopolitics': 100265,   // Geopolitics - 100 events
        'culture': 596,          // Culture (pop-culture) - 66 events
        'world': 101970,         // World - 134 events
        'economy': 100328,       // Economy - 26 events
        'elections': 377,        // Elections 2024
        'breaking': 198,         // Breaking News - 2 events
        'new': null,             // "New" is a sort mode, not a category tag
        'trending': null,        // "Trending" is a sort mode, not a category tag
      };
      
      const kindLower = kind.toLowerCase();
      if (knownTagIds[kindLower]) {
        categoryTagIds = [knownTagIds[kindLower]];
        categoryTagId = knownTagIds[kindLower];
        console.log("[markets] Using known tag ID for", kind, ":", categoryTagId);
      } else {
        // Fallback: Try to find from /tags endpoint
        try {
          const tagsResp = await fetch(`${GAMMA_API}/tags`);
          if (tagsResp.ok) {
            const tags = await tagsResp.json();
            if (Array.isArray(tags)) {
              // Strategy 1: Exact slug match
              const exactMatch = tags.find(tag => {
                const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
                return slug === kindLower;
              });
              
              if (exactMatch && exactMatch.id) {
                categoryTagIds = [exactMatch.id];
                categoryTagId = exactMatch.id;
                console.log("[markets] Found exact tag match for", kind, ":", exactMatch.id, "slug:", exactMatch.slug);
              } else {
                // Strategy 2: Try common variations
                const variations = {
                  'politics': ['politics', 'political', 'uptspt-politics'],
                  'finance': ['finance', 'financial'],
                  'crypto': ['crypto', 'cryptocurrency'],
                  'tech': ['tech', 'technology'],
                  'geopolitics': ['geopolitics', 'geopolitical']
                };
                
                const searchTerms = variations[kindLower] || [kindLower];
                const matchingTags = tags.filter(tag => {
                  const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
                  return searchTerms.some(term => slug === term || slug.includes(term));
                });
                
                if (matchingTags.length > 0) {
                  categoryTagIds = matchingTags.map(tag => tag.id).filter(id => id);
                  categoryTagId = categoryTagIds[0];
                  console.log("[markets] Found tag IDs via variation matching:", categoryTagIds);
                } else {
                  console.log("[markets] WARNING: No tag found for category:", kind);
                }
              }
            }
          }
        } catch (e) {
          console.log("[markets] Error fetching tags for category:", e.message);
        }
      }
      
      // PRIMARY STRATEGY: Fetch from events endpoint - this is how Polymarket structures categories
      // Events have tags, markets are nested inside events
      const tagIdsToUse = categoryTagIds.length > 0 ? categoryTagIds : (categoryTagId ? [categoryTagId] : []);
      
      if (tagIdsToUse.length > 0) {
        console.log("[markets] Fetching events with tag IDs:", tagIdsToUse);
        
        // Fetch events with these tag IDs - events contain their markets
        try {
          // Try multiple event queries in parallel - increase limit to get all events
          const eventQueries = tagIdsToUse.map(tagId => 
            `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=5000`
          );
          
          // Also try direct tag_id filter on events if supported
          eventQueries.push(...tagIdsToUse.map(tagId => 
            `${GAMMA_API}/events?tag_id=${tagId}&closed=false&order=id&ascending=false&limit=5000`
          ));
          
          const eventPromises = eventQueries.map(async (eventUrl) => {
            try {
              const resp = await fetch(eventUrl);
              if (resp.ok) {
                const events = await resp.json();
                return Array.isArray(events) ? events : [];
              }
              return [];
            } catch (e) {
              console.log("[markets] Error fetching events:", e.message);
              return [];
            }
          });
          
          const eventArrays = await Promise.all(eventPromises);
          const allEvents = eventArrays.flat();
          
          // Deduplicate events by ID
          const eventMap = new Map();
          for (const event of allEvents) {
            if (!eventMap.has(event.id)) {
              eventMap.set(event.id, event);
            }
          }
          
          const uniqueEvents = Array.from(eventMap.values());
          console.log("[markets] Found", uniqueEvents.length, "unique events");
          
          // Filter events by category tag IDs - check both string and number format
          // Normalize tag IDs to numbers for consistent comparison
          const normalizedTagIds = tagIdsToUse.map(id => Number(id));
          const categoryEvents = uniqueEvents.filter(event => {
            const eventTags = event.tags || [];
            // Check if event has any of our category tag IDs (handle both string and number)
            return eventTags.some(tag => {
              const tagId = typeof tag === 'object' ? tag.id : tag;
              const normalizedTagId = Number(tagId);
              // Compare normalized numbers
              return normalizedTagIds.includes(normalizedTagId);
            });
          });
          
          console.log("[markets] Found", categoryEvents.length, "events matching category tags", tagIdsToUse);
          
          // Debug: Show sample of events if we found some
          if (categoryEvents.length > 0 && categoryEvents.length < 5) {
            console.log("[markets] Sample category events:", categoryEvents.map(e => ({
              id: e.id,
              title: e.title?.substring(0, 50),
              tags: e.tags?.map(t => typeof t === 'object' ? t.id : t),
              markets: e.markets?.length || 0
            })));
          }
          
          // Extract all markets from category events
          for (const event of categoryEvents) {
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
                      eventTags: event.tags || [],
                    });
                  }
                }
              }
            }
          }
          
          console.log("[markets] Extracted", markets.length, "markets from category events");
        } catch (e) {
          console.log("[markets] Error processing events:", e.message);
        }
      } else {
        console.log("[markets] WARNING: No tag IDs found for category", kind, "- cannot fetch markets");
      }
      
      // FALLBACK: If we still have no markets, try fetching all events and filtering
      if (markets.length === 0 && tagIdsToUse.length > 0) {
        console.log("[markets] No markets from primary strategy, trying comprehensive fallback...");
        try {
          const eventsUrl = `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=5000`;
          const eventsResp = await fetch(eventsUrl);
          if (eventsResp.ok) {
            const events = await eventsResp.json();
            if (Array.isArray(events)) {
              // Normalize tag IDs for comparison
              const normalizedTagIds = tagIdsToUse.map(id => Number(id));
              const categoryEvents = events.filter(event => {
                const eventTags = event.tags || [];
                return eventTags.some(tag => {
                  const tagId = typeof tag === 'object' ? tag.id : tag;
                  const normalizedTagId = Number(tagId);
                  return normalizedTagIds.includes(normalizedTagId);
                });
              });
              
              console.log("[markets] Fallback found", categoryEvents.length, "category events");
              
              for (const event of categoryEvents) {
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
                          eventTags: event.tags || [],
                        });
                      }
                    }
                  }
                }
              }
              console.log("[markets] Fallback extracted", markets.length, "markets");
            }
          }
        } catch (e) {
          console.log("[markets] Error in fallback events fetch:", e.message);
        }
      }
      
      // Strategy 3: If no markets found and we have tag IDs, try filtering all markets by tag
      // This is a fallback in case the tag_id query didn't work
      if (markets.length === 0 && categoryTagIds.length > 0) {
        try {
          console.log("[markets] No markets from tag_id query, trying fallback with tag filtering...");
          const url = `${GAMMA_API}/markets?closed=false&limit=5000`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data)) {
              const categoryMarkets = data.filter(m => {
                if (m.closed || m.active === false) return false;
                
                // Check if market has matching tag_id (exact match only - no keyword matching)
                const marketTags = m.tags || m.tagIds || [];
                const hasTagMatch = (Array.isArray(marketTags) && marketTags.some(tagId => categoryTagIds.includes(tagId))) ||
                                   categoryTagIds.includes(m.tagId) || 
                                   categoryTagIds.includes(m.tag_id);
                
                return hasTagMatch;
              });
              markets.push(...categoryMarkets);
              console.log("[markets] Added", categoryMarkets.length, "markets from fallback tag filtering");
            }
          }
        } catch (e) {
          console.log("[markets] Error in fallback market search:", e.message);
        }
      }
      
      // Log what we found
      if (markets.length === 0) {
        console.log("[markets] WARNING: No markets found for category:", kind);
        console.log("[markets] Tag IDs searched:", categoryTagIds);
        console.log("[markets] This may indicate the tag ID doesn't exist or has no active markets");
      } else {
        console.log("[markets] Successfully found", markets.length, "markets for category:", kind, "using tag IDs:", categoryTagIds);
      }
      
    } else if (isSportsSubcategory) {
      // Fetch game events for a specific sports subcategory (NFL, NBA, etc.)
      // Focus only on NFL for now
      if (kind.toLowerCase() !== "nfl") {
        console.log("[markets] Skipping non-NFL sport:", kind, "- focusing on NFL only for now");
        return res.status(200).json({ 
          markets: [],
          meta: { total: 0, kind, message: "Only NFL is supported at this time" }
        });
      }
      
      const isGamesOnly = sportType === "games";
      console.log("[markets] Fetching NFL games, sportType:", sportType, "gamesOnly:", isGamesOnly);
      console.log("[markets] Current NFL week (estimated):", currentWeek);
      
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
        // Increase limit to get all NFL games
        const eventsUrl = `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=1000`;
        const eventsResp = await fetch(eventsUrl);
        if (eventsResp.ok) {
          const events = await eventsResp.json();
            if (Array.isArray(events)) {
            console.log("[markets] Fetched", events.length, "total events");
            
            // NFL team names for broader matching
            const nflTeams = ['cowboys', 'lions', 'chiefs', 'bills', 'ravens', '49ers', 'rams', 'packers', 
                             'dolphins', 'browns', 'texans', 'bengals', 'jaguars', 'colts', 'steelers', 
                             'jets', 'broncos', 'raiders', 'chargers', 'patriots', 'titans', 'falcons', 
                             'saints', 'buccaneers', 'panthers', 'cardinals', 'seahawks', 'commanders', 
                             'giants', 'eagles', 'bears', 'vikings', 'dallas', 'detroit', 'kansas city',
                             'cincinnati', 'buffalo', 'pittsburgh', 'baltimore', 'seattle', 'atlanta',
                             'tennessee', 'cleveland', 'miami', 'new york', 'new orleans', 'tampa',
                             'indianapolis', 'jacksonville', 'washington', 'minnesota', 'denver', 'las vegas',
                             'chicago', 'green bay', 'los angeles', 'arizona', 'houston',
                             // Team abbreviations
                             'dal', 'det', 'kc', 'buf', 'bal', 'sf', 'lar', 'gb', 'mia', 'cle', 'hou', 
                             'cin', 'jax', 'ind', 'pit', 'nyj', 'den', 'lv', 'lac', 'ne', 'ten', 'atl', 
                             'no', 'tb', 'car', 'ari', 'sea', 'was', 'nyg', 'phi', 'chi', 'min'];
            
            // Filter events by sport keyword - check tags, slug, title, ticker, AND team names
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
              
              // For NFL, also check if event mentions NFL teams (broader matching)
              const hasNflTeams = nflTeams.some(team => 
                eventSlug.includes(team) || 
                eventTitle.includes(team) ||
                eventTicker.includes(team)
              );
              
              // Check for week indicators (common in NFL game events)
              const hasWeek = eventTitle.includes("week") || eventSlug.includes("week") || 
                            eventTags.some(tag => (tag.slug || tag.label || "").toLowerCase().includes("week"));
              
              // Extract week number from event
              const eventWeek = extractWeekNumber(eventTitle) || 
                               extractWeekNumber(eventSlug) ||
                               (eventTags.find(tag => {
                                 const tagText = (tag.slug || tag.label || "").toLowerCase();
                                 return tagText.includes("week");
                               }) ? extractWeekNumber(eventTags.find(tag => {
                                 const tagText = (tag.slug || tag.label || "").toLowerCase();
                                 return tagText.includes("week");
                               }).slug || eventTags.find(tag => {
                                 const tagText = (tag.slug || tag.label || "").toLowerCase();
                                 return tagText.includes("week");
                               }).label) : null);
              
              // Filter by current week - show all games for current week (less strict)
              if (isGamesOnly && eventWeek !== null) {
                // Include if week matches current week or is within 2 weeks ahead (to catch upcoming games)
                if (eventWeek < currentWeek - 2 || eventWeek > currentWeek + 2) {
                  continue; // Skip games from past weeks or too far in future
                }
              }
              
              // Filter by event start date - only exclude games that are clearly in the past
              if (isGamesOnly && event.startDate) {
                const eventStart = new Date(event.startDate);
                // Only skip games that started more than 48 hours ago (give buffer for recent games)
                const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
                if (eventStart < twoDaysAgo) {
                  continue; // Skip games that already happened
                }
                // Don't filter future games - show all upcoming games
              }
              
              // Check for game structure (vs, game indicators)
              const hasGameStructure = eventTitle.includes(" vs ") || eventTitle.includes(" v ") || 
                                      eventSlug.includes(" vs ") || eventSlug.includes(" v ");
              
              // Match if: tags/text match OR (has NFL teams AND (has week OR has game structure))
              const matches = tagMatches || textMatches || (hasNflTeams && (hasWeek || hasGameStructure));
              
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
                    // For games only, exclude only clearly prop markets (be more permissive)
                    if (isGamesOnly) {
                      const question = (market.question || "").toLowerCase();
                      const slug = (market.slug || "").toLowerCase();
                      
                      // BLACKLIST: Only exclude clearly prop markets (season-long awards, MVP, etc.)
                      const isDefinitelyProp = 
                        question.includes("rookie of the year") ||
                        question.includes("offensive rookie") ||
                        question.includes("defensive rookie") ||
                        question.includes("offensive player of the year") ||
                        question.includes("defensive player of the year") ||
                        question.includes("mvp") && !question.includes("vs") && !question.includes("week") ||
                        question.includes("leader") && !question.includes("vs") && !question.includes("week") ||
                        question.includes("award") && !question.includes("vs") ||
                        (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
                        (question.includes("super bowl") && !question.includes("week") && !question.includes("vs")) ||
                        slug.includes("prop") && (slug.includes("mvp") || slug.includes("leader") || slug.includes("rookie"));
                      
                      // Include all markets from game events except clearly props
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
      
      // Strategy 2: Get tag IDs from /sports endpoint (more reliable for NFL)
      // Fetch both endpoints in parallel for faster loading
      let categoryTagIds = [];
      let categoryTagId = null;
      
      // Only process NFL games for now
      if (kind.toLowerCase() === "nfl") {
        // Fetch both endpoints in parallel
        const [sportsResp, tagsResp] = await Promise.all([
          fetch(`${GAMMA_API}/sports`).catch(() => ({ ok: false })),
          fetch(`${GAMMA_API}/tags`).catch(() => ({ ok: false }))
        ]);
        
        // Process /sports endpoint
        if (sportsResp.ok) {
          try {
            const sports = await sportsResp.json();
            if (Array.isArray(sports)) {
              // Find NFL sport entry
              const nflSport = sports.find(s => {
                const sportName = (s.sport || "").toLowerCase();
                return sportName === "nfl";
              });
              
              if (nflSport && nflSport.tags) {
                // Tags are comma-separated string
                const tagIds = nflSport.tags.split(',').map(id => id.trim()).filter(id => id);
                categoryTagIds = tagIds;
                categoryTagId = tagIds[0]; // Use first tag as primary
                console.log("[markets] Found NFL tag IDs from /sports endpoint:", categoryTagIds);
              }
            }
          } catch (e) {
            console.log("[markets] Error parsing /sports:", e.message);
          }
        }
        
        // Fallback: try to get tag ID from /tags endpoint
        if (categoryTagIds.length === 0 && !categoryTagId && tagsResp.ok) {
          try {
            const tags = await tagsResp.json();
            if (Array.isArray(tags)) {
              // Find tag matching the sports subcategory
              const categoryTag = tags.find(tag => {
                const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
                return searchTerms.some(term => slug === term || slug.includes(term));
              });
              if (categoryTag && categoryTag.id) {
                categoryTagId = categoryTag.id;
                categoryTagIds = [categoryTag.id];
                console.log("[markets] Found tag ID from /tags endpoint:", categoryTagId);
            }
          }
        } catch (e) {
            console.log("[markets] Error parsing /tags:", e.message);
          }
        }
      }
      
      // Strategy 3: For NFL games, use multiple approaches to find game markets
      // Since tag-based queries return props, we need to search more broadly
      if (kind.toLowerCase() === "nfl" && isGamesOnly) {
        // Approach 0: Query by NFL series ID first (most direct) - now handled in parallel queries
        
        // Approach 1: Search all events for NFL game events
        // Following docs: /events endpoint is most efficient (events contain their markets)
        // Use order=id&ascending=false to get newest events first
        try {
          // Try multiple event queries in parallel for faster loading - increase limits to get all games
          const eventQueries = [
            `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=1000`,
            `${GAMMA_API}/events?series=10187&closed=false&order=id&ascending=false&limit=1000`,
            `${GAMMA_API}/events?tag_id=1&closed=false&order=id&ascending=false&limit=1000`,
            `${GAMMA_API}/events?tag_id=450&closed=false&order=id&ascending=false&limit=1000`,
            `${GAMMA_API}/events?tag_id=100639&closed=false&order=id&ascending=false&limit=1000`,
          ];
          
          // Fetch all queries in parallel
          const eventPromises = eventQueries.map(async (eventUrl) => {
            try {
              const eventResp = await fetch(eventUrl);
              if (eventResp.ok) {
                const events = await eventResp.json();
                return Array.isArray(events) ? events : [];
              }
              return [];
            } catch (e) {
              console.log("[markets] Error fetching events from", eventUrl, ":", e.message);
              return [];
            }
          });
          
          // Wait for all queries to complete in parallel
          const eventResults = await Promise.all(eventPromises);
          
          // Merge events, avoiding duplicates
          let allEvents = [];
          const eventIds = new Set();
          for (const events of eventResults) {
            for (const event of events) {
              if (!eventIds.has(event.id)) {
                eventIds.add(event.id);
                allEvents.push(event);
              }
            }
          }
          
          if (Array.isArray(allEvents) && allEvents.length > 0) {
              // NFL team names for matching (including abbreviations)
              const nflTeams = ['cowboys', 'lions', 'chiefs', 'bills', 'ravens', '49ers', 'rams', 'packers', 
                               'dolphins', 'browns', 'texans', 'bengals', 'jaguars', 'colts', 'steelers', 
                               'jets', 'broncos', 'raiders', 'chargers', 'patriots', 'titans', 'falcons', 
                               'saints', 'buccaneers', 'panthers', 'cardinals', 'seahawks', 'commanders', 
                               'giants', 'eagles', 'bears', 'vikings', 'dallas', 'detroit', 'kansas city',
                               'cincinnati', 'buffalo', 'pittsburgh', 'baltimore', 'seattle', 'atlanta',
                               'tennessee', 'cleveland', 'miami', 'new york', 'new orleans', 'tampa',
                               'indianapolis', 'jacksonville', 'washington', 'minnesota', 'denver', 'las vegas',
                               'chicago', 'green bay', 'los angeles', 'arizona', 'houston',
                               // Team abbreviations
                               'dal', 'det', 'kc', 'buf', 'bal', 'sf', 'lar', 'gb', 'mia', 'cle', 'hou', 
                               'cin', 'jax', 'ind', 'pit', 'nyj', 'den', 'lv', 'lac', 'ne', 'ten', 'atl', 
                               'no', 'tb', 'car', 'ari', 'sea', 'was', 'nyg', 'phi', 'chi', 'min'];
              
              console.log("[markets] Searching", allEvents.length, "events for NFL games");
              let checkedCount = 0;
              let matchedCount = 0;
              
              // Find events that look like NFL games
              for (const event of allEvents) {
                if (!event.markets || !Array.isArray(event.markets)) continue;
                
                const eventTitle = (event.title || "").toLowerCase();
                const eventSlug = (event.slug || "").toLowerCase();
                const eventTags = (event.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : (t.slug || t.label || "").toLowerCase());
                
                // Check if event is NFL-related
                const hasNflTag = eventTags.some(t => t.includes('nfl'));
                // Check if event title/slug contains NFL teams (use word boundaries to avoid false positives)
                const hasNflTeam = nflTeams.some(team => {
                  // For abbreviations, check for exact match or with word boundaries
                  if (team.length <= 3) {
                    return new RegExp(`\\b${team}\\b`, 'i').test(eventTitle) || new RegExp(`\\b${team}\\b`, 'i').test(eventSlug);
                  }
                  return eventTitle.includes(team) || eventSlug.includes(team);
                });
                
                // Check if markets contain NFL teams
                const marketsHaveTeams = event.markets.some(m => {
                  const q = (m.question || "").toLowerCase();
                  const s = (m.slug || "").toLowerCase();
                  return nflTeams.some(team => {
                    if (team.length <= 3) {
                      return new RegExp(`\\b${team}\\b`, 'i').test(q) || new RegExp(`\\b${team}\\b`, 'i').test(s);
                    }
                    return q.includes(team) || s.includes(team);
                  });
                });
                
                const hasWeek = eventTitle.includes('week') || eventSlug.includes('week') || eventTags.some(t => t.includes('week'));
                const hasVs = eventTitle.includes(" vs ") || eventSlug.includes(" vs ") || eventTitle.includes(" v ");
                
                // Extract week number from event
                const eventWeek = extractWeekNumber(eventTitle) || extractWeekNumber(eventSlug) ||
                                 (eventTags.find(t => t.includes('week')) ? extractWeekNumber(eventTags.find(t => t.includes('week'))) : null);
                
                // Filter by current week - show all games for current week (less strict)
                if (eventWeek !== null) {
                  // Include if week matches current week or is within 2 weeks ahead
                  if (eventWeek < currentWeek - 2 || eventWeek > currentWeek + 2) {
                    continue; // Skip games from past weeks or too far in future
                  }
                }
                
                // Filter by event start date - only exclude games that are clearly in the past
                if (event.startDate) {
                  const eventStart = new Date(event.startDate);
                  // Only skip games that started more than 48 hours ago (give buffer for recent games)
                  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
                  if (eventStart < twoDaysAgo) {
                    continue; // Skip games that already happened
                  }
                  // Don't filter future games - show all upcoming games
                }
                
                // Check if markets look like games
                const hasGameMarkets = event.markets.some(m => {
                  const q = (m.question || "").toLowerCase();
                  return q.includes(" vs ") || q.includes("moneyline") || q.includes("spread") || (q.includes("total") && !q.includes("player"));
                });
                
                // Include if it looks like an NFL game event
                // Be more permissive - include if markets have teams OR event has teams/tags
                if ((hasNflTag || hasNflTeam || marketsHaveTeams) && (hasWeek || hasVs || hasGameMarkets || event.markets.length >= 2)) {
                  checkedCount++;
                  // Exclude if it's clearly a prop event
                  const isPropEvent = eventTitle.includes("mvp") || eventTitle.includes("leader") || 
                                     (eventTitle.includes("champion") && !eventTitle.includes("week")) ||
                                     (eventTitle.includes("super bowl") && !eventTitle.includes("week"));
                  
                  if (!isPropEvent) {
                    matchedCount++;
                    console.log("[markets] Found NFL game event:", eventTitle, "with", event.markets.length, "markets");
                    // If this is a game event, include ALL markets that aren't clearly props
                    // Markets might be structured as team names (e.g., "DAL", "DET", "Cowboys", "Lions")
                    for (const market of event.markets) {
                      if (!market.closed && market.active !== false) {
                        const question = (market.question || "").toLowerCase();
                        const slug = (market.slug || "").toLowerCase();
                        
                        // BLACKLIST: Only exclude clearly prop markets (be more permissive)
                        const isDefinitelyProp = 
                          question.includes("rookie of the year") ||
                          question.includes("offensive rookie") ||
                          question.includes("defensive rookie") ||
                          question.includes("offensive player of the year") ||
                          question.includes("defensive player of the year") ||
                          (question.includes("mvp") && !question.includes("vs") && !question.includes("week")) ||
                          (question.includes("leader") && !question.includes("vs") && !question.includes("week")) ||
                          (question.includes("award") && !question.includes("vs")) ||
                          (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
                          (question.includes("super bowl") && !question.includes("week") && !question.includes("vs")) ||
                          (slug.includes("prop") && (slug.includes("mvp") || slug.includes("leader") || slug.includes("rookie")));
                        
                        // Include all markets from game events except clearly props
                        if (!isDefinitelyProp) {
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
                              eventTags: event.tags || [],
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
              console.log("[markets] Checked", checkedCount, "potential game events, matched", matchedCount, "events, found", markets.length, "markets");
              console.log("[markets] Added NFL game markets from events search");
          }
        } catch (e) {
          console.log("[markets] Error searching events for NFL games:", e.message);
        }
        
        // Approach 2: Query markets directly by NFL tag IDs (most direct)
        try {
          const nflTagIds = [1, 450, 100639];
          console.log("[markets] Querying markets by NFL tag IDs:", nflTagIds);
          for (const tagId of nflTagIds) {
            const tagMarketsUrl = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&limit=2000`;
            const tagMarketsResp = await fetch(tagMarketsUrl);
            if (tagMarketsResp.ok) {
              const tagMarkets = await tagMarketsResp.json();
              if (Array.isArray(tagMarkets)) {
                console.log("[markets] Found", tagMarkets.length, "markets with tag_id", tagId);
                // Add all active markets - we'll filter props in the filtering step below
                for (const market of tagMarkets) {
                  if (!market.closed && market.active !== false) {
                    const existing = markets.find(m => (m.id || m.conditionId) === (market.id || market.conditionId));
                    if (!existing) {
                      markets.push(market);
                    }
                  }
                }
              }
            }
          }
          console.log("[markets] Total markets from tag IDs:", markets.length);
        } catch (e) {
          console.log("[markets] Error fetching markets by tag IDs:", e.message);
        }
        
        // Approach 3: Search all markets for game structure
        try {
          const url = `${GAMMA_API}/markets?closed=false&limit=10000`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data)) {
              const allMarkets = data.filter(m => !m.closed && m.active !== false);
              
              // NFL team names (including abbreviations)
              const nflTeams = ['cowboys', 'lions', 'chiefs', 'bills', 'ravens', '49ers', 'rams', 'packers', 
                               'dolphins', 'browns', 'texans', 'bengals', 'jaguars', 'colts', 'steelers', 
                               'jets', 'broncos', 'raiders', 'chargers', 'patriots', 'titans', 'falcons', 
                               'saints', 'buccaneers', 'panthers', 'cardinals', 'seahawks', 'commanders', 
                               'giants', 'eagles', 'bears', 'vikings', 'dallas', 'detroit', 'kansas city',
                               'cincinnati', 'buffalo', 'pittsburgh', 'baltimore', 'seattle', 'atlanta',
                               'tennessee', 'cleveland', 'miami', 'new york', 'new orleans', 'tampa',
                               'indianapolis', 'jacksonville', 'washington', 'minnesota', 'denver', 'las vegas',
                               'chicago', 'green bay', 'los angeles', 'arizona', 'houston',
                               // Team abbreviations
                               'dal', 'det', 'kc', 'buf', 'bal', 'sf', 'lar', 'gb', 'mia', 'cle', 'hou', 
                               'cin', 'jax', 'ind', 'pit', 'nyj', 'den', 'lv', 'lac', 'ne', 'ten', 'atl', 
                               'no', 'tb', 'car', 'ari', 'sea', 'was', 'nyg', 'phi', 'chi', 'min'];
              
              const gameMarkets = allMarkets.filter(m => {
                const question = (m.question || "").toLowerCase();
                const slug = (m.slug || "").toLowerCase();
                
                // WHITELIST: Must have game structure
                const hasGameStructure = 
                  question.includes(" vs ") ||
                  question.includes(" v ") ||
                  question.includes("moneyline") ||
                  question.includes("ml") ||
                  question.includes("spread") ||
                  question.includes("total") ||
                  question.includes("o/u") ||
                  question.includes("over/under") ||
                  question.includes("over ") ||
                  question.includes("under ") ||
                  slug.includes("moneyline") ||
                  slug.includes("spread") ||
                  slug.includes("total") ||
                  slug.includes("o/u") ||
                  slug.includes("over-under");
                
                // Must mention NFL teams
                const teamCount = nflTeams.filter(team => question.includes(team) || slug.includes(team)).length;
                const hasNflTeams = teamCount > 0;
                
                // BLACKLIST: Exclude all prop markets
                const isWillQuestion = question.includes("will ");
                const isPlayerProp = isWillQuestion && (
                  question.includes("rookie of the year") ||
                  question.includes("offensive rookie") ||
                  question.includes("defensive rookie") ||
                  question.includes("offensive player of the year") ||
                  question.includes("defensive player of the year") ||
                  question.includes("mvp") ||
                  question.includes("leader") ||
                  question.includes("award") ||
                  question.includes("champion") ||
                  question.includes("be the") ||
                  question.includes("in 2025") ||
                  question.includes("in 2026") ||
                  question.includes("2025-2026") ||
                  question.includes("2026-2027")
                );
                
                const isProp = 
                  isPlayerProp ||
                  (!hasGameStructure && isWillQuestion) ||
                  question.includes("rookie of the year") ||
                  question.includes("offensive rookie") ||
                  question.includes("defensive rookie") ||
                  question.includes("offensive player of the year") ||
                  question.includes("defensive player of the year") ||
                  question.includes("mvp") ||
                  question.includes("leader") ||
                  question.includes("award") ||
                  (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
                  (question.includes("super bowl") && !question.includes("week") && !question.includes("vs")) ||
                  (question.includes("playoff") && !question.includes("week") && !question.includes("vs")) ||
                  slug.includes("prop") ||
                  slug.includes("rookie") ||
                  slug.includes("mvp") ||
                  slug.includes("leader");
                
                return hasGameStructure && hasNflTeams && !isProp;
              });
              
              // Add game markets that aren't already included
              for (const market of gameMarkets) {
                const existing = markets.find(m => (m.id || m.conditionId) === (market.id || market.conditionId));
                if (!existing) {
                  markets.push(market);
                }
              }
              console.log("[markets] Added", gameMarkets.length, "NFL game markets from direct market search");
            }
          }
        } catch (e) {
          console.log("[markets] Error searching markets for NFL games:", e.message);
        }
      } else if (kind.toLowerCase() === "nfl" && !isGamesOnly) {
        // For props: fetch by tag IDs
        if (categoryTagIds.length > 0 || categoryTagId) {
          const tagIdsToUse = categoryTagIds.length > 0 ? categoryTagIds : (categoryTagId ? [categoryTagId] : []);
          const marketFetchPromises = tagIdsToUse.map(async (tagId) => {
            try {
              const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&limit=1000`;
            const resp = await fetch(url);
            if (resp.ok) {
              const data = await resp.json();
              if (Array.isArray(data)) {
                  return data.filter(m => !m.closed && m.active !== false);
                }
              }
              return [];
            } catch (e) {
              return [];
            }
          });
          
          try {
            const marketArrays = await Promise.all(marketFetchPromises);
            const newMarkets = marketArrays.flat();
            for (const market of newMarkets) {
              const existing = markets.find(m => m.id === market.id);
              if (!existing) {
                markets.push(market);
              }
            }
            console.log("[markets] Added", newMarkets.length, "NFL markets (props mode)");
          } catch (e) {
            console.log("[markets] Error fetching NFL props:", e.message);
          }
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
        const eventsUrl = `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=100`;
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
                const url = `${GAMMA_API}/markets?tag_id=${tagId}&closed=false&limit=50`;
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
        const url = `${GAMMA_API}/markets?closed=false&limit=10000`;
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
        const eventsUrl = `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=1000`;
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
        const question = (m.question || "").toLowerCase();
        const slug = (m.slug || "").toLowerCase();
        
        // Check if market looks like a game market (has eventId OR has game indicators)
        const hasEventInfo = m.eventId || m.eventTitle || m.eventSlug || m.eventTicker;
        const looksLikeGame = 
          question.includes(" vs ") ||
          question.includes(" v ") ||
          question.includes("moneyline") ||
          question.includes("ml") ||
          question.includes("spread") ||
          (question.includes("total") && !question.includes("player") && !question.includes("leader")) ||
          slug.includes("moneyline") ||
          slug.includes("spread") ||
          slug.includes("total");
        
        // STRICT PROPS FILTERING: Exclude ALL prop markets
        // Any "will" question without game indicators is a prop
        const isWillQuestion = question.includes("will ");
        const hasGameIndicators = question.includes(" vs ") || question.includes(" v ") ||
                                 question.includes("moneyline") || question.includes("spread") ||
                                 question.includes("total") || question.includes("o/u");
        
        const isDefinitelyProp = 
          // "Will" questions without game indicators are props
          (isWillQuestion && !hasGameIndicators) ||
          // Season-long awards and predictions
          question.includes("leader") ||
          question.includes("mvp") ||
          question.includes("award") ||
          question.includes("rookie of the year") ||
          question.includes("offensive rookie") ||
          question.includes("defensive rookie") ||
          question.includes("offensive player of the year") ||
          question.includes("defensive player of the year") ||
          // Championships without week/game context
          (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
          (question.includes("super bowl") && !question.includes("week") && !question.includes("vs")) ||
          (question.includes("playoff") && !question.includes("week") && !question.includes("vs")) ||
          // Winner questions that aren't moneyline
          (question.includes("winner") && !question.includes("week") && !question.includes("vs") && !question.includes("moneyline")) ||
          // Slug-based prop indicators
          slug.includes("prop") ||
          slug.includes("mvp") ||
          slug.includes("leader") ||
          slug.includes("rookie") ||
          // Season-long predictions
          question.includes("in 2025") ||
          question.includes("in 2026") ||
          question.includes("2025-2026") ||
          question.includes("2026-2027") ||
          question.includes("be the"); // "Will X be the Y" is usually a prop
        
        // For games: Include if it has event info OR looks like a game (be more permissive)
        // Polymarket shows all markets from game events, so we should too
        return (hasEventInfo || looksLikeGame) && !isDefinitelyProp;
      });
      console.log("[markets] After games-only filter:", markets.length, "(removed", beforeFilter - markets.length, "non-game markets)");
      
      // Additional filter: Remove outdated games (past week or too far in future)
      const beforeDateFilter = markets.length;
      markets = markets.filter(m => {
        // Check event start date if available
        if (m.eventStartDate) {
          const eventStart = new Date(m.eventStartDate);
          const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
          
          // Skip games that already happened (more than 24 hours ago)
          if (eventStart < oneDayAgo) {
            return false;
          }
          // Skip games too far in the future (more than 2 weeks)
          if (eventStart > twoWeeksFromNow) {
            return false;
          }
        }
        
        // Check week number from event tags or title
        const eventTitle = (m.eventTitle || "").toLowerCase();
        const eventSlug = (m.eventSlug || "").toLowerCase();
        const eventTags = m.eventTags || [];
        
        // Try to extract week from title or slug first
        let eventWeek = extractWeekNumber(eventTitle) || extractWeekNumber(eventSlug);
        
        // If not found, try extracting from tags
        if (!eventWeek && eventTags.length > 0) {
          for (const tag of eventTags) {
            const tagText = typeof tag === 'string' ? tag : (tag.slug || tag.label || "");
            if (tagText.toLowerCase().includes("week")) {
              eventWeek = extractWeekNumber(tagText);
              if (eventWeek) break;
            }
          }
        }
        
        // If we have a week number, filter by current week (less strict)
        if (eventWeek !== null) {
          // Include if week matches current week or is within 2 weeks ahead
          if (eventWeek < currentWeek - 2 || eventWeek > currentWeek + 2) {
            return false; // Skip games from past weeks or too far in future
          }
        }
        
        return true;
      });
      console.log("[markets] After date/week filter:", markets.length, "(removed", beforeDateFilter - markets.length, "outdated games)");
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

    // Filter: must meet minimum volume threshold - always filter out zero-volume markets
    const beforeVolumeFilter = markets.length;
    markets = markets.filter(m => {
      const volume24hr = parseFloat(m.volume24hr) || 0;
      const volume = parseFloat(m.volume) || 0;
      const totalVolume = Math.max(volume24hr, volume);
      // Always exclude zero-volume markets, and apply minVolume threshold if set
      const passes = totalVolume > 0 && totalVolume >= minVolumeNum;
      if (!passes && beforeVolumeFilter < 100) {
        // Log sample of filtered markets for debugging when we have few markets
        console.log("[markets] Filtered market:", m.question?.substring(0, 50), "volume:", totalVolume);
      }
      return passes;
    });
    console.log("[markets] After volume filter (min: $" + minVolumeNum + "):", markets.length, "(removed", beforeVolumeFilter - markets.length, "zero/low-volume markets)");
    
    // If we have very few markets after filtering, log details for debugging
    if (markets.length === 0 && beforeVolumeFilter > 0) {
      console.log("[markets] DEBUG: All markets filtered out by volume. Sample volumes:", 
        beforeVolumeFilter > 0 ? 
          Array.from(new Set(markets.map(m => {
            const v24 = parseFloat(m.volume24hr) || 0;
            const v = parseFloat(m.volume) || 0;
            return Math.max(v24, v);
          }).slice(0, 5))) : 'none'
      );
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
    
    // Final filtering for NFL games: remove props, keep game markets
    if (kind.toLowerCase() === "nfl" && sportType === "games") {
      const nflTeams = ['cowboys', 'lions', 'chiefs', 'bills', 'ravens', '49ers', 'rams', 'packers', 
                        'dolphins', 'browns', 'texans', 'bengals', 'jaguars', 'colts', 'steelers', 
                        'jets', 'broncos', 'raiders', 'chargers', 'patriots', 'titans', 'falcons', 
                        'saints', 'buccaneers', 'panthers', 'cardinals', 'seahawks', 'commanders', 
                        'giants', 'eagles', 'bears', 'vikings', 'dallas', 'detroit', 'kansas city',
                        'cincinnati', 'buffalo', 'pittsburgh', 'baltimore', 'seattle', 'atlanta',
                        'tennessee', 'cleveland', 'miami', 'new york', 'new orleans', 'tampa',
                        'indianapolis', 'jacksonville', 'washington', 'minnesota', 'denver', 'las vegas',
                        'chicago', 'green bay', 'los angeles', 'arizona', 'houston',
                        'dal', 'det', 'kc', 'buf', 'bal', 'sf', 'lar', 'gb', 'mia', 'cle', 'hou', 
                        'cin', 'jax', 'ind', 'pit', 'nyj', 'den', 'lv', 'lac', 'ne', 'ten', 'atl', 
                        'no', 'tb', 'car', 'ari', 'sea', 'was', 'nyg', 'phi', 'chi', 'min'];
      
      console.log("[markets] Filtering", markets.length, "markets for NFL games (removing props)");
      
      // Log sample of what we have before filtering
      if (markets.length > 0) {
        console.log("[markets] Sample markets before filtering:");
        for (const m of markets.slice(0, 5)) {
          console.log(`  - "${m.question || 'N/A'}" (Event: ${m.eventTitle || 'N/A'})`);
        }
      }
      
      const marketsBeforeFilter = markets.length;
      markets = markets.filter(m => {
        const question = (m.question || "").toLowerCase();
        const slug = (m.slug || "").toLowerCase();
        const eventTitle = (m.eventTitle || "").toLowerCase();
        
        // Check if it mentions NFL teams
        const hasNflTeam = nflTeams.some(team => {
          if (team.length <= 3) {
            return new RegExp(`\\b${team}\\b`, 'i').test(question) || 
                   new RegExp(`\\b${team}\\b`, 'i').test(slug) ||
                   new RegExp(`\\b${team}\\b`, 'i').test(eventTitle);
          }
          return question.includes(team) || slug.includes(team) || eventTitle.includes(team);
        });
        
        if (!hasNflTeam) return false; // Must mention NFL teams
        
        // Exclude props
        const isProp = 
          question.includes("will ") && (
            question.includes("rookie of the year") ||
            question.includes("offensive rookie") ||
            question.includes("defensive rookie") ||
            question.includes("mvp") ||
            question.includes("leader") ||
            question.includes("award") ||
            question.includes("champion") ||
            question.includes("be the") ||
            question.includes("in 2025") ||
            question.includes("in 2026") ||
            question.includes("2025-2026") ||
            question.includes("2026-2027") ||
            (question.includes("super bowl") && !question.includes("week") && !question.includes("vs")) ||
            (question.includes("playoff") && !question.includes("week") && !question.includes("vs"))
          ) ||
          question.includes("rookie of the year") ||
          question.includes("offensive rookie") ||
          question.includes("defensive rookie") ||
          question.includes("mvp") ||
          question.includes("leader") ||
          question.includes("award") ||
          (question.includes("champion") && !question.includes("week") && !question.includes("vs")) ||
          (question.includes("super bowl") && !question.includes("week") && !question.includes("vs")) ||
          slug.includes("prop") ||
          slug.includes("rookie") ||
          slug.includes("mvp");
        
        return !isProp; // Keep if not a prop
      });
      console.log("[markets] After filtering:", markets.length, "game markets remaining (filtered out", marketsBeforeFilter - markets.length, "markets)");
      
      // If we have no markets, log what we had before filtering to debug
      if (markets.length === 0 && marketsBeforeFilter > 0) {
        console.log("[markets] WARNING: All markets were filtered out. This might indicate:");
        console.log("[markets] 1. Games aren't in the API yet");
        console.log("[markets] 2. Games are structured differently than expected");
        console.log("[markets] 3. Filtering is too strict");
      }
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
        eventTags: m.eventTags || [],
      };
    });

    console.log("[markets] Returning", transformed.length, "for:", kind);
    // #region agent log
    try { fs.appendFileSync(logPath, JSON.stringify({location:'api/markets.js:1778',message:'Final response',data:{kind, marketCount: transformed.length, sampleQuestions: transformed.slice(0, 3).map(m => m.question?.substring(0, 50))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'}) + '\n'); } catch(e) {}
    // #endregion

    const response = { 
      markets: transformed,
      meta: { total: transformed.length, kind, platform: "polymarket" }
    };

      // Cache the response (only for reasonable limits)
      if (limitNum <= 1000) {
        const cacheKey = getCacheKey(kind, sportType, "polymarket");
        setCache(cacheKey, response);
      }

      return res.status(200).json(response);
    } // End of API fallback block
    
  } catch (err) {
    console.error("[markets] Error:", err.message);
    return res.status(500).json({ 
      error: "fetch_failed", 
      message: err.message,
      markets: [] 
    });
  }
};

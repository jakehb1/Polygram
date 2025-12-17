// api/markets.js
// Fetches markets from Supabase database (mimics Polymarket architecture)
// Falls back to Polymarket Gamma API if database is not configured or empty

// Simple in-memory cache with TTL (2 seconds for near real-time updates)
const cache = new Map();
const CACHE_TTL = 2000; // 2 seconds - reduced for more accurate/real-time data

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

// Extract week number from text (e.g., "week 13", "week-13", "week13")
function extractWeekNumber(text) {
  if (!text) return null;
  const textLower = String(text).toLowerCase();
  // Match patterns like "week 13", "week-13", "week13", "w13"
  const weekMatch = textLower.match(/\b(?:week[\s\-]?|w)(\d{1,2})\b/);
  if (weekMatch && weekMatch[1]) {
    const weekNum = parseInt(weekMatch[1], 10);
    if (weekNum >= 1 && weekNum <= 18) { // NFL regular season is 18 weeks
      return weekNum;
    }
  }
  return null;
}

// Get current NFL week based on date
// NFL season typically starts in early September (week 1)
function getCurrentNFLWeek() {
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // NFL season typically starts around September 5-10 (Week 1)
  // Calculate approximate start date (first Thursday of September)
  let seasonStart = new Date(currentYear, 8, 1); // September 1st
  // Find first Thursday in September
  while (seasonStart.getDay() !== 4) { // 4 = Thursday
    seasonStart.setDate(seasonStart.getDate() + 1);
  }
  // Adjust to September 5-10 range (typical NFL season start)
  if (seasonStart.getDate() < 5) {
    seasonStart.setDate(5);
  } else if (seasonStart.getDate() > 10) {
    seasonStart.setDate(5);
  }
  
  // If we're before the season start, check previous year
  if (now < seasonStart) {
    seasonStart = new Date(currentYear - 1, 8, 1);
    while (seasonStart.getDay() !== 4) {
      seasonStart.setDate(seasonStart.getDate() + 1);
    }
    if (seasonStart.getDate() < 5) {
      seasonStart.setDate(5);
    } else if (seasonStart.getDate() > 10) {
      seasonStart.setDate(5);
    }
  }
  
  // Calculate weeks since season start (each week is 7 days)
  const daysDiff = Math.floor((now - seasonStart) / (1000 * 60 * 60 * 24));
  const weekNum = Math.floor(daysDiff / 7) + 1;
  
  // Clamp to valid NFL weeks (1-18 for regular season, 19-22 for playoffs)
  if (weekNum < 1) return 1;
  if (weekNum > 22) return null; // Season ended
  
  return weekNum;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { kind = "trending", limit = "1000", sportType = null, platform = "polymarket", week = null } = req.query;
  
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
      
      // Return 503 (Service Unavailable) for configuration errors, 500 for API errors
      const statusCode = error.message.includes("not configured") || error.message.includes("authentication failed") 
        ? 503 
        : 500;
      
      return res.status(statusCode).json({
        error: "kalshi_fetch_failed",
        message: error.message,
        markets: [],
        requiresAuth: true,
      });
    }
  }
  
  // Default to Polymarket (existing logic continues below)
  // Allow much higher limits to get all markets (default 1000, max 10000)
  const limitNum = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
  // Parse minVolume - default to 0 (no filter) to match Polymarket's behavior
  // Only filter if explicitly requested - Polymarket shows all active markets regardless of volume
  const minVolumeProvided = req.query.minVolume !== undefined && req.query.minVolume !== null;
  const minVolumeParsed = minVolumeProvided ? Number(req.query.minVolume) : 0;
  const minVolumeNum = Math.max(isNaN(minVolumeParsed) ? 0 : minVolumeParsed, 0);
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
      const estimatedCurrentWeek = getCurrentNFLWeek();
      console.log("[markets] Fetching NFL games, sportType:", sportType, "gamesOnly:", isGamesOnly);
      console.log("[markets] Current NFL week (estimated):", estimatedCurrentWeek);
      
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
            console.log("[markets] Checked", checkedCount, "events, matched", matchedCount, "NFL game events");
          } else {
            console.log("[markets] WARNING: No events returned from API queries");
          }
        }
      } catch (e) {
        console.log("[markets] Error fetching events:", e.message);
        console.error("[markets] Error stack:", e.stack);
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
      
      // Strategy 3: For NFL games, query events with NFL tag and filter by week
      // This is the ONLY path for NFL games - no fallback to all markets
      if (kind.toLowerCase() === "nfl" && isGamesOnly && isSportsSubcategory) {
        console.log("[markets] Entering NFL games-only path (no fallback to all markets)");
        // Determine target week: use provided week parameter, or default to current week
        const targetWeek = week ? parseInt(week, 10) : getCurrentNFLWeek();
        
        console.log("[markets] Fetching NFL games for week:", targetWeek);
        
        try {
          // Get NFL tag ID(s) - use the tag IDs we found from /sports endpoint
          let nflTagIds = categoryTagIds.length > 0 ? categoryTagIds : [];
          
          // Fallback: use known NFL tag IDs if /sports didn't work
          // NFL is typically under Sports (tag 1), but we need to check events with tag 1 and filter for NFL
          // Also try known NFL-specific tag IDs
          if (nflTagIds.length === 0) {
            // Sports tag is 1, but that includes all sports
            // We'll fetch events and filter by checking if they're NFL in the event title/slug
            nflTagIds = [1]; // Start with Sports tag, filter for NFL events below
            console.log("[markets] Using fallback: fetching all Sports events (tag 1) and filtering for NFL");
          }
          
          console.log("[markets] Using NFL tag IDs for filtering:", nflTagIds);
          
          // Query events - the API may not support tag_id as query param, so fetch all and filter
          // Try multiple approaches to get NFL events
          const eventQueries = [
            // Try fetching all events and filter by tags (most reliable)
            `${GAMMA_API}/events?closed=false&limit=1000`,
            // Try with series parameter
            `${GAMMA_API}/events?series=10187&closed=false&limit=500`,
          ];
          
          // Fetch all queries in parallel
          const eventPromises = eventQueries.map(async (eventUrl) => {
            try {
              const eventResp = await fetch(eventUrl);
              if (eventResp.ok) {
                const events = await eventResp.json();
                const eventsArray = Array.isArray(events) ? events : [];
                
                // Filter events that have NFL tags OR are NFL events
                if (nflTagIds.length > 0) {
                  const filtered = eventsArray.filter(event => {
                    const eventTags = event.tags || [];
                    const hasNflTag = eventTags.some(tag => {
                      const tagId = typeof tag === 'object' ? tag.id : tag;
                      return nflTagIds.includes(Number(tagId));
                    });
                    
                    // If tag is just "Sports" (1), also check if it's actually an NFL event
                    // Sports tag includes ALL sports (NFL, NBA, esports, etc.), so we need strict filtering
                    if (hasNflTag && nflTagIds.includes(1) && nflTagIds.length === 1) {
                      // Additional check: verify it's NFL and not other sports
                      const eventTitle = (event.title || "").toLowerCase();
                      const eventSlug = (event.slug || "").toLowerCase();
                      const eventText = `${eventTitle} ${eventSlug}`;
                      
                      // STRICT: Must explicitly mention NFL or have NFL team names
                      const hasNflKeyword = eventText.includes('nfl') || 
                                           eventText.includes('national football league');
                      
                      // Check for NFL team names (32 official teams)
                      const nflTeamKeywords = [
                        'bills', 'buffalo bills', 'dolphins', 'miami dolphins', 'patriots', 'new england patriots', 'jets', 'new york jets',
                        'ravens', 'baltimore ravens', 'bengals', 'cincinnati bengals', 'browns', 'cleveland browns', 'steelers', 'pittsburgh steelers',
                        'texans', 'houston texans', 'colts', 'indianapolis colts', 'jaguars', 'jacksonville jaguars', 'titans', 'tennessee titans',
                        'broncos', 'denver broncos', 'chiefs', 'kansas city chiefs', 'raiders', 'las vegas raiders', 'chargers', 'los angeles chargers',
                        'cowboys', 'dallas cowboys', 'giants', 'new york giants', 'eagles', 'philadelphia eagles', 'commanders', 'washington commanders',
                        'bears', 'chicago bears', 'lions', 'detroit lions', 'packers', 'green bay packers', 'vikings', 'minnesota vikings',
                        'falcons', 'atlanta falcons', 'panthers', 'carolina panthers', 'saints', 'new orleans saints', 'buccaneers', 'tampa bay buccaneers',
                        'cardinals', 'arizona cardinals', 'rams', 'los angeles rams', '49ers', 'san francisco 49ers', 'seahawks', 'seattle seahawks',
                        'buf', 'mia', 'ne', 'nyj', 'bal', 'cin', 'cle', 'pit', 'hou', 'ind', 'jax', 'ten', 'den', 'kc', 'lv', 'lac',
                        'dal', 'nyg', 'phi', 'was', 'wsh', 'chi', 'det', 'gb', 'min', 'atl', 'car', 'no', 'tb', 'ari', 'lar', 'sf', 'sea'
                      ];
                      const hasNflTeam = nflTeamKeywords.some(team => eventText.includes(team));
                      
                      // EXCLUDE: Esports, other sports
                      const isEsports = eventText.includes('counter-strike') || 
                                       eventText.includes('cs:') ||
                                       eventText.includes('cs2') ||
                                       eventText.includes('esports') ||
                                       eventText.includes('dota') ||
                                       eventText.includes('league of legends') ||
                                       eventText.includes('lol');
                      const isOtherSport = eventText.includes('nba') || 
                                          eventText.includes('mlb') || 
                                          eventText.includes('nhl') ||
                                          eventText.includes('soccer') ||
                                          eventText.includes('basketball') ||
                                          eventText.includes('baseball') ||
                                          eventText.includes('hockey');
                      
                      // Only include if it has NFL keyword OR NFL team, AND not esports/other sports
                      const isNfl = (hasNflKeyword || hasNflTeam) && !isEsports && !isOtherSport;
                      
                      if (!isNfl) {
                        console.log("[markets] Excluding non-NFL event:", event.title, "hasNflKeyword:", hasNflKeyword, "hasNflTeam:", hasNflTeam, "isEsports:", isEsports);
                      }
                      
                      return isNfl;
                    }
                    
                    return hasNflTag;
                  });
                  console.log("[markets] Filtered", filtered.length, "NFL events from", eventsArray.length, "total events");
                  return filtered;
                }
                
                return eventsArray;
              } else {
                console.log("[markets] Events API returned status:", eventResp.status);
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
          
          console.log("[markets] Total events after merging:", allEvents.length);
          
          if (Array.isArray(allEvents) && allEvents.length > 0) {
              // Determine target week: use provided week parameter, or default to current week
              const targetWeek = week ? parseInt(week, 10) : getCurrentNFLWeek();
              
              console.log("[markets] Found", allEvents.length, "events from NFL tag queries");
              console.log("[markets] Filtering for week:", targetWeek, week ? "(specified)" : "(current)");
              
              // Log sample events for debugging
              console.log("[markets] Sample events:", allEvents.slice(0, 3).map(e => ({
                id: e.id,
                title: e.title?.substring(0, 50),
                slug: e.slug?.substring(0, 50),
                tags: e.tags?.map(t => typeof t === 'object' ? t.id : t),
                marketsCount: e.markets?.length || 0
              })));
              
              let matchedEvents = 0;
              
              // Simple filtering: events already have NFL tag, so they're NFL events
              // Just filter by week and exclude college/props
              for (const event of allEvents) {
                if (!event.markets || !Array.isArray(event.markets) || event.markets.length === 0) continue;
                
                const eventTitle = (event.title || "").toLowerCase();
                const eventSlug = (event.slug || "").toLowerCase();
                const eventText = `${eventTitle} ${eventSlug}`.toLowerCase();
                
                // EXCLUDE: Esports and other sports (Counter-Strike, NBA, etc.)
                const isEsports = eventText.includes('counter-strike') || 
                                 eventText.includes('cs:') ||
                                 eventText.includes('cs2') ||
                                 eventText.includes('esports') ||
                                 eventText.includes('dota') ||
                                 eventText.includes('league of legends') ||
                                 eventText.includes('lol') ||
                                 eventText.includes('valorant') ||
                                 eventText.includes('rocket league');
                const isOtherSport = eventText.includes('nba') || 
                                    eventText.includes('mlb') || 
                                    eventText.includes('nhl') ||
                                    eventText.includes('soccer') ||
                                    eventText.includes('basketball') ||
                                    eventText.includes('baseball') ||
                                    eventText.includes('hockey') ||
                                    eventText.includes('tennis') ||
                                    eventText.includes('golf') ||
                                    eventText.includes('ufc') ||
                                    eventText.includes('boxing');
                
                if (isEsports || isOtherSport) {
                  console.log("[markets] Excluding non-NFL sport event:", event.title, "isEsports:", isEsports, "isOtherSport:", isOtherSport);
                  continue;
                }
                
                // Exclude college/NCAA football explicitly - be very aggressive
                // Check for NCAA, college football, college team indicators
                const collegeIndicators = [
                  'ncaa', 'cfb', 'college football', 'college', 'espn college',
                  'state bulldogs', 'state', 'university', 'uni', 'school',
                  'south carolina state', 'jacksonville state', 'troy state',
                  'aggies', 'crimson tide', 'sooners', 'longhorns', 'tigers',
                  'wildcats', 'bulldogs', 'eagles', 'hawks', 'wolverines'
                ];
                const hasCollegeIndicator = collegeIndicators.some(indicator => 
                  eventText.includes(indicator)
                );
                // Also check if it has "State" in team names (NFL teams don't have "State")
                const hasStateInName = /\b\w+\s+state\b/i.test(eventTitle);
                if (hasCollegeIndicator || hasStateInName) {
                  console.log("[markets] Excluding college game:", event.title);
                  continue;
                }
                
                // CRITICAL: Must have at least TWO NFL team keywords (a matchup requires two teams)
                // This ensures we're only getting actual NFL game matchups, not other content
                const nflTeamKeywords = [
                  'bills', 'buffalo bills', 'dolphins', 'miami dolphins', 'patriots', 'new england patriots', 'jets', 'new york jets',
                  'ravens', 'baltimore ravens', 'bengals', 'cincinnati bengals', 'browns', 'cleveland browns', 'steelers', 'pittsburgh steelers',
                  'texans', 'houston texans', 'colts', 'indianapolis colts', 'jaguars', 'jacksonville jaguars', 'titans', 'tennessee titans',
                  'broncos', 'denver broncos', 'chiefs', 'kansas city chiefs', 'raiders', 'las vegas raiders', 'chargers', 'los angeles chargers',
                  'cowboys', 'dallas cowboys', 'giants', 'new york giants', 'eagles', 'philadelphia eagles', 'commanders', 'washington commanders',
                  'bears', 'chicago bears', 'lions', 'detroit lions', 'packers', 'green bay packers', 'vikings', 'minnesota vikings',
                  'falcons', 'atlanta falcons', 'panthers', 'carolina panthers', 'saints', 'new orleans saints', 'buccaneers', 'tampa bay buccaneers',
                  'cardinals', 'arizona cardinals', 'rams', 'los angeles rams', '49ers', 'san francisco 49ers', 'seahawks', 'seattle seahawks',
                  // Team abbreviations (use word boundaries to avoid false matches)
                  'buf', 'mia', 'ne', 'nyj', 'bal', 'cin', 'cle', 'pit', 'hou', 'ind', 'jax', 'ten', 'den', 'kc', 'lv', 'lac',
                  'dal', 'nyg', 'phi', 'was', 'wsh', 'chi', 'det', 'gb', 'min', 'atl', 'car', 'no', 'tb', 'ari', 'lar', 'sf', 'sea'
                ];
                
                // Count how many NFL teams are mentioned
                const teamMatches = nflTeamKeywords.filter(team => {
                  // For short abbreviations, use word boundaries
                  if (team.length <= 3) {
                    const regex = new RegExp(`\\b${team}\\b`, 'i');
                    return regex.test(eventText);
                  }
                  return eventText.includes(team);
                });
                
                // Require at least 2 different NFL teams (a game matchup)
                // OR at least 1 team + "nfl" keyword + week indicator
                const hasMultipleTeams = teamMatches.length >= 2;
                const hasNflKeyword = eventText.includes('nfl') || eventText.includes('national football league');
                const hasWeekIndicator = eventText.includes('week') || extractWeekNumber(eventTitle) !== null || extractWeekNumber(eventSlug) !== null;
                const hasSingleTeamWithContext = teamMatches.length >= 1 && hasNflKeyword && hasWeekIndicator;
                
                if (!hasMultipleTeams && !hasSingleTeamWithContext) {
                  console.log("[markets] No NFL team matchup found in event:", event.title, "teamMatches:", teamMatches.length);
                  continue; // Skip if no NFL team matchup found
                }
                
                console.log("[markets] NFL matchup found:", event.title, "teams:", teamMatches.length, "team names:", teamMatches.slice(0, 2));
                
                // Extract and filter by week
                const eventWeek = extractWeekNumber(eventTitle) || extractWeekNumber(eventSlug);
                
                // Filter by week: if we can extract week number, it must match target week
                // But if we can't extract week, check if event date is within current week range
                if (targetWeek !== null) {
                  if (eventWeek !== null && eventWeek !== targetWeek) {
                    continue; // Skip events from other weeks if we can confirm the week
                  }
                  
                  // If no week info, check event date to determine if it's in the target week
                  // NFL weeks typically run Thu-Sun, so calculate week date range
                  if (eventWeek === null && event.startDate) {
                    const eventDate = new Date(event.startDate);
                    const now = new Date();
                    const currentYear = now.getFullYear();
                    
                    // Calculate season start (first Thursday in September, around Sept 5-10)
                    let seasonStart = new Date(currentYear, 8, 1);
                    while (seasonStart.getDay() !== 4) seasonStart.setDate(seasonStart.getDate() + 1);
                    if (seasonStart.getDate() < 5) seasonStart.setDate(5);
                    else if (seasonStart.getDate() > 10) seasonStart.setDate(5);
                    
                    if (now < seasonStart) {
                      seasonStart = new Date(currentYear - 1, 8, 1);
                      while (seasonStart.getDay() !== 4) seasonStart.setDate(seasonStart.getDate() + 1);
                      if (seasonStart.getDate() < 5) seasonStart.setDate(5);
                      else if (seasonStart.getDate() > 10) seasonStart.setDate(5);
                    }
                    
                    // Calculate target week date range (each week is 7 days, Thu-Wed)
                    const weekStart = new Date(seasonStart);
                    weekStart.setDate(seasonStart.getDate() + (targetWeek - 1) * 7);
                    const weekEnd = new Date(weekStart);
                    weekEnd.setDate(weekStart.getDate() + 7);
                    
                    // If event date is outside target week range, skip it
                    if (eventDate < weekStart || eventDate >= weekEnd) {
                      continue;
                    }
                  }
                }
                
                // Exclude prop events (MVP, leaders, etc.)
                if (eventTitle.includes("mvp") || eventTitle.includes("leader") || 
                    (eventTitle.includes("champion") && !eventTitle.includes("week"))) {
                  continue;
                }
                
                // Exclude games that have already happened
                // Only exclude if we have a startDate - if no date, include it (might be upcoming)
                if (event.startDate) {
                  const eventStart = new Date(event.startDate);
                  const now = new Date();
                  // If event start time is more than 3 hours in the past, exclude it
                  // (games typically last ~3 hours, so 3 hours after start means game is likely over)
                  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
                  if (isNaN(eventStart.getTime())) {
                    console.log("[markets] Invalid event startDate, including event:", event.title);
                  } else if (eventStart < threeHoursAgo) {
                    console.log("[markets] Excluding past game:", event.title, "started:", eventStart.toISOString());
                    continue; // Skip games that already happened
                  }
                }
                
                matchedEvents++;
                // Log event details including date for debugging
                const eventDateStr = event.startDate ? new Date(event.startDate).toISOString() : 'no date';
                console.log("[markets] Including NFL event:", event.title, "Week:", eventWeek || "unknown", "Date:", eventDateStr, "startDate:", event.startDate);
                
                // Include all markets from this event (they're already NFL games from NFL-tagged events)
                // But verify markets also mention NFL teams to be extra sure
                for (const market of event.markets) {
                  if (market.closed || market.active === false) continue;
                  
                  // Exclude obvious props at market level
                  const question = (market.question || "").toLowerCase();
                  const slug = (market.slug || "").toLowerCase();
                  const marketText = `${question} ${slug}`;
                  
                  // Verify this market mentions at least one NFL team
                  const marketHasNflTeam = nflTeamKeywords.some(team => {
                    if (team.length <= 3) {
                      const regex = new RegExp(`\\b${team}\\b`, 'i');
                      return regex.test(marketText);
                    }
                    return marketText.includes(team);
                  });
                  
                  // Also check for NFL keyword in market
                  const marketHasNflKeyword = marketText.includes('nfl') || marketText.includes('national football league');
                  
                  // Skip if it's a prop AND doesn't mention NFL teams
                  const isProp = question.includes("mvp") || question.includes("leader") || 
                                question.includes("rookie of the year") ||
                                question.includes("offensive player") ||
                                question.includes("defensive player");
                  
                  if (isProp && !marketHasNflTeam && !marketHasNflKeyword) {
                    continue;
                  }
                  
                  // For game markets, require NFL team or NFL keyword
                  if (!isProp && !marketHasNflTeam && !marketHasNflKeyword) {
                    console.log("[markets] Skipping market without NFL team/keyword:", question);
                    continue;
                  }
                  
                  const existing = markets.find(m => (m.id || m.conditionId) === (market.id || market.conditionId));
                  if (!existing) {
                    // CRITICAL: Preserve ALL market volume fields - these must come from market, not event
                    // Market volumes are individual per market, event volumes are aggregate
                    // Also ensure event.startDate is properly passed through
                    markets.push({
                      ...market, // Spread all market fields first
                      // Explicitly preserve volume fields from market (handle different API field name variations)
                      volume: market.volume !== undefined ? market.volume : (typeof market.volume === 'string' ? parseFloat(market.volume) || 0 : 0),
                      volume24hr: market.volume24hr !== undefined ? market.volume24hr : (market.volume24h !== undefined ? market.volume24h : (typeof market.volume24hr === 'string' ? parseFloat(market.volume24hr) || 0 : 0)),
                      volume1wk: market.volume1wk !== undefined ? market.volume1wk : (market.volume1w !== undefined ? market.volume1w : (typeof market.volume1wk === 'string' ? parseFloat(market.volume1wk) || 0 : 0)),
                      liquidity: market.liquidity !== undefined ? market.liquidity : (typeof market.liquidity === 'string' ? parseFloat(market.liquidity) || 0 : 0),
                      // Add event metadata (these are separate from market fields)
                      eventId: event.id,
                      eventTitle: event.title,
                      eventSlug: event.slug,
                      eventTicker: event.ticker,
                      eventStartDate: event.startDate || event.start_date || null, // Try both field names
                      eventEndDate: event.endDate || event.end_date || null,
                      eventImage: event.image || event.icon,
                      eventVolume: event.volume, // Event volume is aggregate - separate from market volume
                      eventLiquidity: event.liquidity, // Event liquidity is aggregate - separate from market liquidity
                      eventTags: event.tags || [],
                    });
                  }
                }
              }
              console.log("[markets] Matched", matchedEvents, "NFL events, found", markets.length, "markets");
              console.log("[markets] Added NFL game markets from events search");
          } else {
              console.log("[markets] WARNING: No events found from API queries");
              console.log("[markets] Possible reasons:");
              console.log("[markets] 1. API returned empty arrays");
              console.log("[markets] 2. No events match the NFL tag filter (tag IDs:", nflTagIds, ")");
              console.log("[markets] 3. The tag IDs we're using might be incorrect");
          }
        } catch (e) {
          console.log("[markets] Error searching events for NFL games:", e.message);
          console.error("[markets] Error stack:", e.stack);
        }
        
        // NOTE: We ONLY use the /events endpoint for NFL games to ensure we get the correct data
        // Do NOT query /markets directly as it pulls in non-NFL games (college football, etc.)
        // The /events endpoint with NFL tag_id gives us the correct NFL games organized by week
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

    // Filter: If sportType is "games" and NFL, only include NFL game markets
    // Exclude props, futures, and other non-game markets
    // Also exclude other sports (only NFL games for now) - STRICT filtering
    if (sportType === "games" && isSportsSubcategory && kind.toLowerCase() === "nfl") {
      // First pass: Filter out non-NFL sports before other checks
      const beforeSportFilter = markets.length;
      // Official NFL teams only (32 teams)
      // AFC East: Bills, Dolphins, Patriots, Jets
      // AFC North: Ravens, Bengals, Browns, Steelers
      // AFC South: Texans, Colts, Jaguars, Titans
      // AFC West: Broncos, Chiefs, Raiders, Chargers
      // NFC East: Cowboys, Giants, Eagles, Commanders
      // NFC North: Bears, Lions, Packers, Vikings
      // NFC South: Falcons, Panthers, Saints, Buccaneers
      // NFC West: Cardinals, Rams, 49ers, Seahawks
      const nflTeamKeywords = [
        // AFC East
        'bills', 'buffalo bills', 'dolphins', 'miami dolphins', 'patriots', 'new england patriots', 'jets', 'new york jets',
        // AFC North
        'ravens', 'baltimore ravens', 'bengals', 'cincinnati bengals', 'browns', 'cleveland browns', 'steelers', 'pittsburgh steelers',
        // AFC South
        'texans', 'houston texans', 'colts', 'indianapolis colts', 'jaguars', 'jacksonville jaguars', 'titans', 'tennessee titans',
        // AFC West
        'broncos', 'denver broncos', 'chiefs', 'kansas city chiefs', 'raiders', 'las vegas raiders', 'chargers', 'los angeles chargers',
        // NFC East
        'cowboys', 'dallas cowboys', 'giants', 'new york giants', 'eagles', 'philadelphia eagles', 'commanders', 'washington commanders',
        // NFC North
        'bears', 'chicago bears', 'lions', 'detroit lions', 'packers', 'green bay packers', 'vikings', 'minnesota vikings',
        // NFC South
        'falcons', 'atlanta falcons', 'panthers', 'carolina panthers', 'saints', 'new orleans saints', 'buccaneers', 'tampa bay buccaneers',
        // NFC West
        'cardinals', 'arizona cardinals', 'rams', 'los angeles rams', '49ers', 'san francisco 49ers', 'seahawks', 'seattle seahawks',
        // Team abbreviations
        'buf', 'mia', 'ne', 'nyj', 'bal', 'cin', 'cle', 'pit', 'hou', 'ind', 'jax', 'ten', 'den', 'kc', 'lv', 'lac',
        'dal', 'nyg', 'phi', 'was', 'wsh', 'chi', 'det', 'gb', 'min', 'atl', 'car', 'no', 'tb', 'ari', 'lar', 'sf', 'sea'
      ];
      // Non-NFL sports and teams to exclude
      // Include college teams, esports, soccer leagues, and other sports
      const nonNflSports = [
        // College Football - be very aggressive with detection
        'college football', 'cfb', 'ncaa', 'ncaaf', 'espn college', 'college', 
        'miami hurricanes', 'texas a&m', 'texas a and m', 'texas a&m aggies',
        'troy', 'jacksonville state', 'washington state', 'utah state',
        // Esports
        'dota', 'dota 2', 'esports', 'team falcons', 'parivision',
        // Soccer/Football leagues
        'serie a', 'ac milan', 'hellas verona', 'premier league', 'la liga', 'bundesliga', 'soccer',
        // Other sports
        'nba', 'mlb', 'nhl', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'ufc', 'boxing', 'cricket'
      ];
      
      markets = markets.filter(m => {
        const marketText = `${m.question || ''} ${m.slug || ''} ${m.eventTitle || ''}`.toLowerCase();
        
        // FIRST: Exclude esports (Counter-Strike, CS2, etc.) - these can have team names that match NFL teams
        const isEsports = marketText.includes('counter-strike') || 
                         marketText.includes('cs:') ||
                         marketText.includes('cs2') ||
                         marketText.includes('esports') ||
                         marketText.includes('dota') ||
                         marketText.includes('league of legends') ||
                         marketText.includes('lol') ||
                         marketText.includes('valorant') ||
                         marketText.includes('rocket league');
        if (isEsports) {
          return false; // Strictly exclude esports - team names can overlap with NFL
        }
        
        // Second: check for NCAA/college football explicitly - must exclude
        const hasCollegeFootball = /ncaa|cfb|college\s+football|espn\s+college/.test(marketText);
        if (hasCollegeFootball && !marketText.includes('nfl')) {
          return false; // Strictly exclude college/NCAA markets
        }
        
        // Then check for other non-NFL sports
        const mentionsOtherSport = nonNflSports.some(sport => {
          const sportLower = sport.toLowerCase();
          // For short terms, use word boundaries to avoid false positives
          if (sportLower.length <= 4) {
            return new RegExp(`\\b${sportLower}\\b`, 'i').test(marketText);
          }
          return marketText.includes(sportLower);
        });
        if (mentionsOtherSport) {
          return false; // Strictly exclude - don't allow any non-NFL sports
        }
        
        // Must have NFL keyword OR multiple NFL teams (to avoid false matches with esports)
        const hasNflKeyword = marketText.includes('nfl') || marketText.includes('national football league');
        
        // Count NFL teams mentioned (use word boundaries for abbreviations)
        const teamMatches = nflTeamKeywords.filter(team => {
          if (team.length <= 3) {
            const regex = new RegExp(`\\b${team}\\b`, 'i');
            return regex.test(marketText);
          }
          return marketText.includes(team);
        });
        
        // Require NFL keyword OR at least 2 NFL teams (a matchup)
        // This prevents false matches where esports teams share names with NFL teams
        const hasNflIndicator = hasNflKeyword || teamMatches.length >= 2;
        
        return hasNflIndicator; // Only keep if it has strong NFL indicators
      });
      console.log("[markets] After sport filter (NFL only):", markets.length, "(removed", beforeSportFilter - markets.length, "non-NFL markets)");
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
      
      // Additional filter: Remove games that have already happened
      const beforeDateFilter = markets.length;
      markets = markets.filter(m => {
        // Check event start date if available
        if (m.eventStartDate) {
          const eventStart = new Date(m.eventStartDate);
          const now = new Date();
          // Only filter if date is valid
          if (!isNaN(eventStart.getTime())) {
            // Exclude games that started more than 3 hours ago (games typically last ~3 hours)
            // This ensures we only show active/upcoming games, not past games
            const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
            if (eventStart < threeHoursAgo) {
              return false; // Skip games that already happened
            }
          }
          // If date is invalid or in the future, include the market
          // Don't filter future games - show all upcoming games
        }
        // If no date, include the market (might be upcoming)
        
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
        
        // If we have a week number, filter by current week (more permissive)
        if (eventWeek !== null) {
          // Include if week matches current week or is within 4 weeks ahead/behind (more permissive)
          if (eventWeek < currentWeek - 4 || eventWeek > currentWeek + 4) {
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

    // Filter: must meet minimum volume threshold (only if minVolumeNum > 0)
    // Don't filter by volume by default - match Polymarket's behavior of showing all active markets
    if (minVolumeNum > 0) {
      const beforeVolumeFilter = markets.length;
      markets = markets.filter(m => {
        const volume24hr = parseFloat(m.volume24hr) || 0;
        const volume = parseFloat(m.volume) || 0;
        const totalVolume = Math.max(volume24hr, volume);
        const passes = totalVolume >= minVolumeNum;
        if (!passes && beforeVolumeFilter < 100) {
          // Log sample of filtered markets for debugging when we have few markets
          console.log("[markets] Filtered market:", m.question?.substring(0, 50), "volume:", totalVolume);
        }
        return passes;
      });
      console.log("[markets] After volume filter (min: $" + minVolumeNum + "):", markets.length, "(removed", beforeVolumeFilter - markets.length, "low-volume markets)");
    } else {
      console.log("[markets] No volume filter applied - showing all active markets (matching Polymarket behavior)");
    }
    
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

    // Sort markets to match Polymarket's behavior
    // For "trending": Sort by volume24hr (24-hour volume indicates trending activity)
    // For "volume": Sort by total volume (all-time volume)
    // For "new": Sort by creation date (newest first)
    // For categories: Sort by volume24hr (most active first)
    if (kind === "volume") {
      // Sort by total volume (all-time)
      markets.sort((a, b) => {
        const volA = parseFloat(a.volume) || parseFloat(a.volume24hr) || 0;
        const volB = parseFloat(b.volume) || parseFloat(b.volume24hr) || 0;
        return volB - volA;
      });
    } else if (kind === "new") {
      // Sort by creation date (newest first)
      markets.sort((a, b) => {
        const dateA = new Date(a.createdAt || a.startDate || 0);
        const dateB = new Date(b.createdAt || b.startDate || 0);
        return dateB - dateA;
      });
    } else {
      // Default: Sort by volume24hr (trending/category views use 24hr volume)
      markets.sort((a, b) => {
        const volA = parseFloat(a.volume24hr) || parseFloat(a.volume) || 0;
        const volB = parseFloat(b.volume24hr) || parseFloat(b.volume) || 0;
        return volB - volA;
      });
    }
    
    // Final filtering for NFL games: remove props, keep game markets
    if (kind.toLowerCase() === "nfl" && sportType === "games") {
      // Official NFL teams only (32 teams) - full names and abbreviations
      // AFC East: Bills, Dolphins, Patriots, Jets
      // AFC North: Ravens, Bengals, Browns, Steelers
      // AFC South: Texans, Colts, Jaguars, Titans
      // AFC West: Broncos, Chiefs, Raiders, Chargers
      // NFC East: Cowboys, Giants, Eagles, Commanders
      // NFC North: Bears, Lions, Packers, Vikings
      // NFC South: Falcons, Panthers, Saints, Buccaneers
      // NFC West: Cardinals, Rams, 49ers, Seahawks
      const nflTeams = [
        // Team names
        'bills', 'buffalo bills', 'dolphins', 'miami dolphins', 'patriots', 'new england patriots', 'jets', 'new york jets',
        'ravens', 'baltimore ravens', 'bengals', 'cincinnati bengals', 'browns', 'cleveland browns', 'steelers', 'pittsburgh steelers',
        'texans', 'houston texans', 'colts', 'indianapolis colts', 'jaguars', 'jacksonville jaguars', 'titans', 'tennessee titans',
        'broncos', 'denver broncos', 'chiefs', 'kansas city chiefs', 'raiders', 'las vegas raiders', 'chargers', 'los angeles chargers',
        'cowboys', 'dallas cowboys', 'giants', 'new york giants', 'eagles', 'philadelphia eagles', 'commanders', 'washington commanders',
        'bears', 'chicago bears', 'lions', 'detroit lions', 'packers', 'green bay packers', 'vikings', 'minnesota vikings',
        'falcons', 'atlanta falcons', 'panthers', 'carolina panthers', 'saints', 'new orleans saints', 'buccaneers', 'tampa bay buccaneers',
        'cardinals', 'arizona cardinals', 'rams', 'los angeles rams', '49ers', 'san francisco 49ers', 'seahawks', 'seattle seahawks',
        // City names (for context matching)
        'buffalo', 'miami', 'new england', 'new york', 'baltimore', 'cincinnati', 'cleveland', 'pittsburgh',
        'houston', 'indianapolis', 'jacksonville', 'tennessee', 'denver', 'kansas city', 'las vegas', 'los angeles',
        'dallas', 'philadelphia', 'washington', 'chicago', 'detroit', 'green bay', 'minnesota', 'atlanta',
        'carolina', 'new orleans', 'tampa', 'tampa bay', 'arizona', 'san francisco', 'seattle',
        // Team abbreviations
        'buf', 'mia', 'ne', 'nyj', 'bal', 'cin', 'cle', 'pit', 'hou', 'ind', 'jax', 'ten', 'den', 'kc', 'lv', 'lac',
        'dal', 'nyg', 'phi', 'was', 'wsh', 'chi', 'det', 'gb', 'min', 'atl', 'car', 'no', 'tb', 'ari', 'lar', 'sf', 'sea'
      ];
      
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
        
        // Check for other sports - exclude if it's clearly not NFL
        // Include college football, esports, soccer leagues, and other non-NFL sports
        const otherSports = [
          'nba', 'mlb', 'nhl', 'soccer', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'ufc', 'boxing', 'cricket',
          'premier league', 'la liga', 'serie a', 'bundesliga', 'college football', 'cfb', 'ncaa', 'dota', 'esports',
          'miami', 'texas a&m', 'washington state', 'utah state', 'troy', 'jacksonville state', 'ac milan', 'hellas verona',
          'team falcons', 'parivision', 'over', 'under'
        ];
        const hasOtherSport = otherSports.some(sport => {
          const marketText = `${question} ${slug} ${eventTitle}`.toLowerCase();
          // Exclude if it contains other sport terms (unless it also has strong NFL indicators)
          if (marketText.includes(sport)) {
            // If it has NFL tag or strong NFL indicators, keep it; otherwise exclude
            return !marketText.includes('nfl') && !hasNflTeam;
          }
          return false;
        });
        
        // STRICT: Must have NFL teams AND not be other sports
        if (!hasNflTeam || hasOtherSport) {
          return false; // Exclude if no NFL teams or if it's another sport
        }
        
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
        console.log("[markets] Sample of markets that were filtered out (from earlier in pipeline):");
        // Note: We can't access the original markets here, but the earlier logging should have shown them
      }
      
      // If we still have markets after filtering, log a sample
      if (markets.length > 0) {
        console.log("[markets] Sample of remaining game markets (first 5):");
        for (const m of markets.slice(0, 5)) {
          console.log(`  - "${m.question || 'N/A'}" (Event: ${m.eventTitle || 'N/A'})`);
        }
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

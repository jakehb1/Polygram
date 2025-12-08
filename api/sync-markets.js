// api/sync-markets.js
// Background job to sync markets and categories from Polymarket to Supabase
// This mimics Polymarket's architecture by storing markets and categories in our database

const GAMMA_API = "https://gamma-api.polymarket.com";

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  
  // Optional: Add authentication/API key check for production
  // const apiKey = req.headers['x-api-key'];
  // if (apiKey !== process.env.SYNC_API_KEY) {
  //   return res.status(401).json({ error: "unauthorized" });
  // }

  const { category = null, full = false, sync_categories = true } = req.query;
  
  try {
    // Check Supabase connection
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ 
        error: "supabase_not_configured",
        message: "Supabase not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY."
      });
    }

    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    let syncedCount = 0;
    let eventCount = 0;
    let categoriesSynced = 0;

    // Sync categories first (if enabled)
    if (sync_categories !== 'false') {
      console.log("[sync-markets] Syncing categories from Polymarket...");
      try {
        categoriesSynced = await syncCategories(supabase);
        console.log(`[sync-markets] Synced ${categoriesSynced} categories`);
      } catch (err) {
        console.error("[sync-markets] Error syncing categories:", err.message);
        // Don't fail the whole sync if categories fail
      }
    }

    if (category) {
      // Sync specific category
      const tagId = CATEGORY_TAG_IDS[category.toLowerCase()];
      if (!tagId) {
        return res.status(400).json({ error: "invalid_category", message: `Unknown category: ${category}` });
      }
      
      const result = await syncCategory(supabase, category, tagId, full);
      syncedCount = result.markets;
      eventCount = result.events;
    } else if (full) {
      // Full sync: all categories
      console.log("[sync-markets] Starting full sync of all categories...");
      for (const [cat, tagId] of Object.entries(CATEGORY_TAG_IDS)) {
        console.log(`[sync-markets] Syncing category: ${cat} (tag ID: ${tagId})`);
        const result = await syncCategory(supabase, cat, tagId, true);
        syncedCount += result.markets;
        eventCount += result.events;
      }
    } else {
      // Default: sync all categories (incremental)
      for (const [cat, tagId] of Object.entries(CATEGORY_TAG_IDS)) {
        const result = await syncCategory(supabase, cat, tagId, false);
        syncedCount += result.markets;
        eventCount += result.events;
      }
    }

    return res.status(200).json({
      success: true,
      synced_markets: syncedCount,
      synced_events: eventCount,
      synced_categories: categoriesSynced,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("[sync-markets] Error:", err);
    return res.status(500).json({
      error: "sync_failed",
      message: err.message
    });
  }
};

async function syncCategory(supabase, category, tagId, fullSync = false) {
  console.log(`[sync-markets] Syncing category: ${category} (tag ID: ${tagId})`);
  
  let marketsSynced = 0;
  let eventsSynced = 0;

  try {
    // Fetch events from Polymarket
    const eventsUrl = `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=5000`;
    const eventsResp = await fetch(eventsUrl);
    
    if (!eventsResp.ok) {
      throw new Error(`Events API returned ${eventsResp.status}`);
    }

    const events = await eventsResp.json();
    if (!Array.isArray(events)) {
      throw new Error("Events API returned non-array");
    }

    // Filter events by category tag
    const normalizedTagId = Number(tagId);
    const categoryEvents = events.filter(event => {
      const eventTags = event.tags || [];
      return eventTags.some(tag => {
        const tagId = typeof tag === 'object' ? tag.id : tag;
        return Number(tagId) === normalizedTagId;
      });
    });

    console.log(`[sync-markets] Found ${categoryEvents.length} events for ${category}`);

    // Sync events first
    for (const event of categoryEvents) {
      const eventData = {
        id: String(event.id),
        title: event.title,
        slug: event.slug,
        ticker: event.ticker,
        description: event.description,
        image: event.image || event.icon,
        icon: event.icon,
        volume: parseFloat(event.volume) || 0,
        liquidity: parseFloat(event.liquidity) || 0,
        tags: event.tags || [],
        start_date: event.startDate ? new Date(event.startDate).toISOString() : null,
        end_date: event.endDate ? new Date(event.endDate).toISOString() : null,
        closed: event.closed || false,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Upsert event
      const { error: eventError } = await supabase
        .from('market_events')
        .upsert(eventData, { onConflict: 'id' });

      if (eventError) {
        console.error(`[sync-markets] Error upserting event ${event.id}:`, eventError);
      } else {
        eventsSynced++;
      }

      // Sync markets from this event
      if (event.markets && Array.isArray(event.markets)) {
        for (const market of event.markets) {
          // Only sync active, non-closed markets
          if (market.closed || market.active === false) continue;

          // Extract tag IDs from event and market
          const eventTagIds = (event.tags || []).map(t => typeof t === 'object' ? t.id : t);
          const marketTagIds = (market.tags || []).map(t => typeof t === 'object' ? t.id : t);
          const allTagIds = [...new Set([...eventTagIds, ...marketTagIds])]; // Combine and dedupe

          const marketData = {
            id: String(market.id || market.conditionId),
            condition_id: market.conditionId ? String(market.conditionId) : null,
            question: market.question || market.title || '',
            slug: market.slug || '',
            description: market.description || '',
            image: market.image || event.image || event.icon || market.icon || null,
            icon: market.icon || event.icon || null,
            outcomes: market.outcomes || [],
            outcome_prices: market.outcomePrices || market.prices || [],
            volume: parseFloat(market.volume) || 0,
            volume_24hr: parseFloat(market.volume24hr || market.volume24h) || 0,
            volume_1wk: parseFloat(market.volume1wk || market.volume1w) || 0,
            liquidity: parseFloat(market.liquidity) || 0,
            active: market.active !== false,
            closed: market.closed || false,
            resolved: market.resolved || false,
            event_id: String(event.id),
            event_title: event.title,
            event_slug: event.slug,
            event_image: event.image || event.icon,
            event_start_date: event.startDate ? new Date(event.startDate).toISOString() : null,
            event_end_date: event.endDate ? new Date(event.endDate).toISOString() : null,
            event_tags: event.tags || [],
            category: category,
            tag_ids: allTagIds,
            resolution_source: market.resolutionSource || market.resolution_source || null,
            end_date: market.endDate ? new Date(market.endDate).toISOString() : null,
            start_date: market.startDate ? new Date(market.startDate).toISOString() : null,
            created_at_pm: market.createdAt ? new Date(market.createdAt).toISOString() : null,
            updated_at_pm: market.updatedAt ? new Date(market.updatedAt).toISOString() : null,
            synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          // Upsert market
          const { error: marketError } = await supabase
            .from('markets')
            .upsert(marketData, { onConflict: 'id' });

          if (marketError) {
            console.error(`[sync-markets] Error upserting market ${market.id}:`, marketError);
          } else {
            marketsSynced++;
            
            // Track price history for this market
            try {
              const outcomes = market.outcomes || ["Yes", "No"];
              const prices = market.outcomePrices || [];
              const priceHistoryRecords = [];
              
              outcomes.forEach((outcome, index) => {
                const price = prices[index] !== undefined ? parseFloat(prices[index]) : null;
                if (price !== null && !isNaN(price)) {
                  priceHistoryRecords.push({
                    market_id: String(market.id || market.conditionId),
                    condition_id: market.conditionId ? String(market.conditionId) : null,
                    outcome_index: index,
                    outcome_name: outcome,
                    price: price,
                    volume: parseFloat(market.volume24hr) || parseFloat(market.volume) || 0,
                    liquidity: parseFloat(market.liquidity) || 0,
                    timestamp: new Date().toISOString()
                  });
                }
              });
              
              // Insert price history records (upsert to avoid duplicates if sync runs multiple times per minute)
              if (priceHistoryRecords.length > 0) {
                const { error: historyError } = await supabase
                  .from('market_price_history')
                  .upsert(priceHistoryRecords, { 
                    onConflict: 'market_price_history_market_outcome_idx',
                    ignoreDuplicates: false // Update if exists (to refresh price)
                  });
                
                if (historyError) {
                  console.error(`[sync-markets] Error tracking price history for market ${market.id}:`, historyError);
                }
              }
            } catch (historyErr) {
              console.error(`[sync-markets] Error in price history tracking:`, historyErr.message);
              // Don't fail the whole sync if price history fails
            }
          }
        }
      }
    }

    // Also fetch markets directly (not just from events) to ensure we get all markets
    // Some markets might not be in events or might have been missed
    console.log(`[sync-markets] Fetching markets directly for category ${category}...`);
    
    try {
      const marketsUrl = `${GAMMA_API}/markets?closed=false&active=true&limit=5000`;
      const marketsResp = await fetch(marketsUrl);
      
      if (marketsResp.ok) {
        const allMarkets = await marketsResp.json();
        if (Array.isArray(allMarkets)) {
          // Filter markets by category tag
          const categoryMarkets = allMarkets.filter(market => {
            // Check if market has the category tag
            const marketTags = market.tags || [];
            const hasCategoryTag = marketTags.some(tag => {
              const tagId = typeof tag === 'object' ? tag.id : tag;
              return Number(tagId) === normalizedTagId;
            });
            
            // Also check if market's event has the category tag
            if (market.eventId) {
              const event = categoryEvents.find(e => String(e.id) === String(market.eventId));
              if (event) return true; // Already synced from event
            }
            
            return hasCategoryTag;
          });
          
          console.log(`[sync-markets] Found ${categoryMarkets.length} additional markets directly`);
          
          // Sync these markets (they might not have events or might be standalone)
          for (const market of categoryMarkets) {
            // Skip if already synced from events
            if (market.eventId) {
              const event = categoryEvents.find(e => String(e.id) === String(market.eventId));
              if (event) continue; // Already synced
            }
            
            // Only sync active, non-closed markets
            if (market.closed || market.active === false) continue;
            
            // Extract tag IDs
            const marketTagIds = (market.tags || []).map(t => typeof t === 'object' ? t.id : t);
            
            const marketData = {
              id: String(market.id || market.conditionId),
              condition_id: market.conditionId ? String(market.conditionId) : null,
              question: market.question || market.title || '',
              slug: market.slug || '',
              description: market.description || '',
              image: market.image || market.icon || null,
              icon: market.icon || null,
              outcomes: market.outcomes || [],
              outcome_prices: market.outcomePrices || market.prices || [],
              volume: parseFloat(market.volume) || 0,
              volume_24hr: parseFloat(market.volume24hr || market.volume24h) || 0,
              volume_1wk: parseFloat(market.volume1wk || market.volume1w) || 0,
              liquidity: parseFloat(market.liquidity) || 0,
              active: market.active !== false,
              closed: market.closed || false,
              resolved: market.resolved || false,
              event_id: market.eventId ? String(market.eventId) : null,
              event_title: market.eventTitle || market.event?.title || null,
              event_slug: market.eventSlug || market.event?.slug || null,
              event_image: market.eventImage || market.event?.image || market.event?.icon || null,
              event_start_date: market.eventStartDate ? new Date(market.eventStartDate).toISOString() : null,
              event_end_date: market.eventEndDate ? new Date(market.eventEndDate).toISOString() : null,
              event_tags: market.eventTags || market.event?.tags || [],
              category: category,
              tag_ids: marketTagIds,
              resolution_source: market.resolutionSource || market.resolution_source || null,
              end_date: market.endDate ? new Date(market.endDate).toISOString() : null,
              start_date: market.startDate ? new Date(market.startDate).toISOString() : null,
              created_at_pm: market.createdAt ? new Date(market.createdAt).toISOString() : null,
              updated_at_pm: market.updatedAt ? new Date(market.updatedAt).toISOString() : null,
              synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            
            // Upsert market
            const { error: marketError } = await supabase
              .from('markets')
              .upsert(marketData, { onConflict: 'id' });
            
            if (marketError) {
              console.error(`[sync-markets] Error upserting direct market ${market.id}:`, marketError);
            } else {
              marketsSynced++;
              
              // Track price history for this market
              try {
                const outcomes = market.outcomes || ["Yes", "No"];
                const prices = market.outcomePrices || market.prices || [];
                const priceHistoryRecords = [];
                
                outcomes.forEach((outcome, index) => {
                  const price = prices[index] !== undefined ? parseFloat(prices[index]) : null;
                  if (price !== null && !isNaN(price)) {
                    priceHistoryRecords.push({
                      market_id: String(market.id || market.conditionId),
                      condition_id: market.conditionId ? String(market.conditionId) : null,
                      outcome_index: index,
                      outcome_name: outcome,
                      price: price,
                      volume: parseFloat(market.volume24hr || market.volume24h) || parseFloat(market.volume) || 0,
                      liquidity: parseFloat(market.liquidity) || 0,
                      timestamp: new Date().toISOString()
                    });
                  }
                });
                
                // Insert price history records
                if (priceHistoryRecords.length > 0) {
                  const { error: historyError } = await supabase
                    .from('market_price_history')
                    .upsert(priceHistoryRecords, { 
                      onConflict: 'market_price_history_market_outcome_idx',
                      ignoreDuplicates: false
                    });
                  
                  if (historyError) {
                    console.error(`[sync-markets] Error tracking price history for direct market ${market.id}:`, historyError);
                  }
                }
              } catch (historyErr) {
                console.error(`[sync-markets] Error in price history tracking for direct market:`, historyErr.message);
              }
            }
          }
        }
      }
    } catch (directMarketErr) {
      console.error(`[sync-markets] Error fetching direct markets:`, directMarketErr.message);
      // Don't fail the whole sync if direct market fetch fails
    }
    
    console.log(`[sync-markets] Synced ${marketsSynced} markets and ${eventsSynced} events for ${category}`);
    
    return { markets: marketsSynced, events: eventsSynced };

  } catch (err) {
    console.error(`[sync-markets] Error syncing category ${category}:`, err);
    throw err;
  }
}

async function syncCategories(supabase) {
  console.log("[sync-markets] Fetching categories from Polymarket...");
  
  try {
    const GAMMA_API = "https://gamma-api.polymarket.com";
    const tagsResp = await fetch(`${GAMMA_API}/tags`);
    
    if (!tagsResp.ok) {
      throw new Error(`Tags API returned ${tagsResp.status}`);
    }

    const tags = await tagsResp.json();
    if (!Array.isArray(tags)) {
      throw new Error("Tags API returned non-array");
    }

    console.log(`[sync-markets] Found ${tags.length} tags from Polymarket`);

    // Known category mappings (sort modes and main categories)
    const categoryMap = {
      "trending": { label: "Trending", slug: "trending", isSort: true, isCategory: false, orderIndex: 1 },
      "breaking": { label: "Breaking", slug: "breaking", isSort: true, isCategory: false, orderIndex: 2 },
      "new": { label: "New", slug: "new", isSort: true, isCategory: false, orderIndex: 3 },
      "politics": { label: "Politics", slug: "politics", isCategory: true, isSort: false, orderIndex: 10 },
      "sports": { label: "Sports", slug: "sports", isCategory: true, isSort: false, orderIndex: 11 },
      "finance": { label: "Finance", slug: "finance", isCategory: true, isSort: false, orderIndex: 12 },
      "crypto": { label: "Crypto", slug: "crypto", isCategory: true, isSort: false, orderIndex: 13 },
      "geopolitics": { label: "Geopolitics", slug: "geopolitics", isCategory: true, isSort: false, orderIndex: 14 },
      "tech": { label: "Tech", slug: "tech", isCategory: true, isSort: false, orderIndex: 15 },
      "culture": { label: "Culture", slug: "culture", isCategory: true, isSort: false, orderIndex: 16 },
      "world": { label: "World", slug: "world", isCategory: true, isSort: false, orderIndex: 17 },
      "economy": { label: "Economy", slug: "economy", isCategory: true, isSort: false, orderIndex: 18 },
      "elections": { label: "Elections", slug: "elections", isCategory: true, isSort: false, orderIndex: 19 },
    };

    // Build tag slug to ID map
    const tagSlugToId = new Map();
    for (const tag of tags) {
      if (tag.id) {
        const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
        if (slug) {
          tagSlugToId.set(slug, tag.id);
        }
      }
    }

    let categoriesSynced = 0;
    const seenSlugs = new Set();

    // Sync predefined categories first
    for (const [key, cat] of Object.entries(categoryMap)) {
      let tagId = null;
      
      // Look up tag ID from Polymarket tags
      if (cat.isCategory) {
        tagId = tagSlugToId.get(cat.slug) || null;
        
        // If not found, search by label
        if (!tagId) {
          for (const tag of tags) {
            const tagSlug = (tag.slug || tag.label || tag.name || "").toLowerCase();
            if (tagSlug === cat.slug.toLowerCase() && tag.id) {
              tagId = tag.id;
              break;
            }
          }
        }
      }

      const categoryData = {
        id: key,
        tag_id: tagId ? String(tagId) : null,
        label: cat.label,
        slug: cat.slug,
        icon: "",
        is_sort: cat.isSort || false,
        is_category: cat.isCategory || false,
        order_index: cat.orderIndex || 0,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('categories')
        .upsert(categoryData, { onConflict: 'id' });

      if (error) {
        console.error(`[sync-markets] Error upserting category ${key}:`, error);
      } else {
        categoriesSynced++;
        seenSlugs.add(cat.slug);
      }
    }

    // Sync additional categories from Polymarket tags (popular ones)
    // Only add categories that have significant usage
    const excludeTerms = new Set([
      'saudi arabia', 'united states', 'russia', 'china', 'india', 'brazil', 'japan',
      'germany', 'france', 'uk', 'united kingdom', 'canada', 'australia', 'south korea',
      'italy', 'spain', 'mexico', 'indonesia', 'netherlands', 'turkey', 'switzerland',
      'poland', 'belgium', 'sweden', 'norway', 'denmark', 'finland', 'ireland',
      'portugal', 'greece', 'czech republic', 'romania', 'hungary', 'ukraine',
      'israel', 'egypt', 'south africa', 'argentina', 'chile', 'colombia', 'peru',
      'philippines', 'vietnam', 'thailand', 'malaysia', 'singapore', 'new zealand',
      'saudi', 'arabia', 'arab', 'emirates', 'qatar', 'kuwait', 'bahrain', 'oman'
    ]);

    let additionalCount = 0;
    for (const tag of tags) {
      if (additionalCount >= 10) break; // Limit additional categories
      
      const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
      const label = tag.label || tag.name || slug;
      
      if (seenSlugs.has(slug) || !tag.id) continue;
      if (excludeTerms.has(slug)) continue;
      
      const words = slug.split(/\s+/);
      if (words.length > 2) continue;
      
      const isMainCategory = !slug.includes("-") || slug.split("-").length <= 2;
      const isProperNoun = /^[A-Z]/.test(label) && words.length === 1;
      if (isProperNoun && !['nfl', 'nba', 'mlb', 'nhl', 'ufc', 'wnba', 'cbb', 'cfb'].includes(slug)) {
        continue;
      }
      
      if (isMainCategory) {
        const categoryData = {
          id: String(tag.id),
          tag_id: String(tag.id),
          label: label.charAt(0).toUpperCase() + label.slice(1),
          slug: slug,
          icon: "",
          is_sort: false,
          is_category: true,
          order_index: 100 + additionalCount, // Put additional categories at end
          force_show: tag.forceShow || false,
          force_hide: tag.forceHide || false,
          published_at: tag.publishedAt ? new Date(tag.publishedAt).toISOString() : null,
          synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        const { error } = await supabase
          .from('categories')
          .upsert(categoryData, { onConflict: 'id' });

        if (!error) {
          categoriesSynced++;
          additionalCount++;
          seenSlugs.add(slug);
        }
      }
    }

    console.log(`[sync-markets] Synced ${categoriesSynced} categories (${Object.keys(categoryMap).length} predefined + ${additionalCount} additional)`);
    
    return categoriesSynced;

  } catch (err) {
    console.error("[sync-markets] Error syncing categories:", err);
    throw err;
  }
}


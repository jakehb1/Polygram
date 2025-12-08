// api/categories.js
// Fetches all available categories/tags from Polymarket Gamma API

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const GAMMA_API = "https://gamma-api.polymarket.com";
  
  try {
    // Fetch all tags/categories
    const tagsResp = await fetch(`${GAMMA_API}/tags`);
    
    if (!tagsResp.ok) {
      return res.status(500).json({ 
        error: "fetch_failed", 
        message: `Tags API returned ${tagsResp.status}`,
        categories: [] 
      });
    }

    const tags = await tagsResp.json();
    
    if (!Array.isArray(tags)) {
      return res.status(200).json({ 
        categories: [],
        meta: { total: 0 }
      });
    }

    // Map Polymarket categories to our format
    // Common categories based on Polymarket's structure
    const categoryMap = {
      "trending": { label: "Trending", icon: "", slug: "trending", isSort: true },
      "breaking": { label: "Breaking", icon: "", slug: "breaking", isSort: true },
      "new": { label: "New", icon: "", slug: "new", isSort: true },
      "politics": { label: "Politics", icon: "", slug: "politics", isCategory: true },
      "sports": { label: "Sports", icon: "", slug: "sports", isCategory: true },
      "finance": { label: "Finance", icon: "", slug: "finance", isCategory: true },
      "crypto": { label: "Crypto", icon: "", slug: "crypto", isCategory: true },
      "geopolitics": { label: "Geopolitics", icon: "", slug: "geopolitics", isCategory: true },
      "earnings": { label: "Earnings", icon: "", slug: "earnings", isCategory: true },
      "tech": { label: "Tech", icon: "", slug: "tech", isCategory: true },
      "culture": { label: "Culture", icon: "", slug: "culture", isCategory: true },
      "world": { label: "World", icon: "", slug: "world", isCategory: true },
      "economy": { label: "Economy", icon: "", slug: "economy", isCategory: true },
      "elections": { label: "Elections", icon: "", slug: "elections", isCategory: true },
    };

    // Extract unique categories from tags
    const categories = [];
    const seenSlugs = new Set();
    
    // List of country names and other non-category terms to exclude
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
    
    // First, build a map of tag slugs to tag IDs for lookup
    const tagSlugToId = new Map();
    for (const tag of tags) {
      if (tag.id) {
        const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
        if (slug) {
          tagSlugToId.set(slug, tag.id);
        }
      }
    }
    
    // Add predefined categories first, looking up tagId from API tags
    // Use exact slug matching to get the same tag IDs Polymarket uses
    for (const [key, cat] of Object.entries(categoryMap)) {
      // For sort modes, tagId stays null. For categories, look up the tagId by exact slug match
      let tagId = null;
      if (cat.isCategory && !cat.isSort) {
        // Exact match first (most reliable)
        tagId = tagSlugToId.get(cat.slug) || null;
        
        // If exact match fails, try to find by label/name
        if (!tagId) {
          for (const tag of tags) {
            const tagSlug = (tag.slug || tag.label || tag.name || "").toLowerCase();
            if (tagSlug === cat.slug.toLowerCase() && tag.id) {
              tagId = tag.id;
              break;
            }
          }
        }
        
        if (tagId) {
          console.log(`[categories] Found tag ID for ${cat.slug}: ${tagId}`);
        } else {
          console.log(`[categories] WARNING: No tag ID found for ${cat.slug}`);
        }
      }
      
      // Always add predefined categories - they should match Polymarket's structure
      categories.push({
        id: key,
        label: cat.label,
        icon: cat.icon,
        slug: cat.slug,
        isSort: cat.isSort || false,
        isCategory: cat.isCategory || false,
        tagId: tagId, // Exact tag ID from Polymarket's /tags endpoint
      });
      seenSlugs.add(cat.slug);
    }

    // Add additional categories from tags that aren't already included
    // Only add well-known category types, exclude countries and specific entities
    for (const tag of tags) {
      const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
      const label = tag.label || tag.name || slug;
      
      // Skip if we already have this category or if it's too generic
      if (seenSlugs.has(slug) || !tag.id) continue;
      
      // Exclude country names and other non-category terms
      if (excludeTerms.has(slug)) continue;
      
      // Exclude if it contains country-like patterns (multiple words, proper nouns)
      const words = slug.split(/\s+/);
      if (words.length > 2) continue; // Too specific
      
      // Only add if it looks like a main category (not too specific)
      const isMainCategory = !slug.includes("-") || slug.split("-").length <= 2;
      
      // Additional check: exclude if it looks like a person name or specific entity
      const isProperNoun = /^[A-Z]/.test(label) && words.length === 1;
      if (isProperNoun && !['nfl', 'nba', 'mlb', 'nhl', 'ufc', 'wnba', 'cbb', 'cfb'].includes(slug)) {
        continue;
      }
      
      if (isMainCategory && categories.length < 25) {
        categories.push({
          id: tag.id,
          label: label.charAt(0).toUpperCase() + label.slice(1),
          icon: "",
          slug: slug,
          isSort: false,
          isCategory: true,
          tagId: tag.id,
        });
        seenSlugs.add(slug);
      }
    }

    console.log(`[categories] Returning ${categories.length} categories`);

    return res.status(200).json({ 
      categories: categories,
      meta: { total: categories.length }
    });
    
  } catch (err) {
    console.error("[categories] Error:", err.message);
    return res.status(500).json({ 
      error: "fetch_failed", 
      message: err.message,
      categories: [] 
    });
  }
};


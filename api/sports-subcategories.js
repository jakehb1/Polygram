// api/sports-subcategories.js
// Fetches sports subcategories (NFL, NBA, MLB, etc.) from Polymarket

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const GAMMA_API = "https://gamma-api.polymarket.com";
  
  try {
    // Fetch all tags
    const tagsResp = await fetch(`${GAMMA_API}/tags`);
    
    if (!tagsResp.ok) {
      return res.status(500).json({ 
        error: "fetch_failed", 
        message: `Tags API returned ${tagsResp.status}`,
        subcategories: [] 
      });
    }

    const tags = await tagsResp.json();
    
    if (!Array.isArray(tags)) {
      return res.status(200).json({ 
        subcategories: [],
        meta: { total: 0 }
      });
    }

    // Hardcoded list of known sports subcategories on Polymarket
    // These are the main sports leagues/categories that have active markets
    const knownSports = [
      { slug: 'nfl', label: 'NFL', searchTerms: ['nfl', 'american football'] },
      { slug: 'nba', label: 'NBA', searchTerms: ['nba', 'basketball'] },
      { slug: 'mlb', label: 'MLB', searchTerms: ['mlb', 'baseball'] },
      { slug: 'nhl', label: 'NHL', searchTerms: ['nhl', 'hockey'] },
      { slug: 'wnba', label: 'WNBA', searchTerms: ['wnba'] },
      { slug: 'ufc', label: 'UFC', searchTerms: ['ufc', 'mma'] },
      { slug: 'epl', label: 'EPL', searchTerms: ['epl', 'premier league', 'english premier league'] },
      { slug: 'cfb', label: 'College Football', searchTerms: ['cfb', 'college football', 'ncaaf', 'ncaa football'] },
      { slug: 'cbb', label: 'College Basketball', searchTerms: ['cbb', 'college basketball', 'ncaab', 'ncaa basketball'] },
      { slug: 'mls', label: 'MLS', searchTerms: ['mls', 'major league soccer'] },
      { slug: 'la-liga', label: 'La Liga', searchTerms: ['la liga', 'laliga'] },
      { slug: 'bundesliga', label: 'Bundesliga', searchTerms: ['bundesliga'] },
      { slug: 'serie-a', label: 'Serie A', searchTerms: ['serie a', 'seriea'] },
      { slug: 'ligue-1', label: 'Ligue 1', searchTerms: ['ligue 1', 'ligue1'] },
      { slug: 'tennis', label: 'Tennis', searchTerms: ['tennis'] },
      { slug: 'golf', label: 'Golf', searchTerms: ['golf'] },
      { slug: 'boxing', label: 'Boxing', searchTerms: ['boxing'] },
      { slug: 'formula-1', label: 'Formula 1', searchTerms: ['formula 1', 'formula1', 'f1'] },
      { slug: 'cricket', label: 'Cricket', searchTerms: ['cricket'] },
    ];

    const subcategories = [];
    const seenSlugs = new Set();

    // First, try to find tags from the API that match our known sports
    for (const tag of tags) {
      if (!tag.id) continue;
      
      const tagSlug = (tag.slug || tag.label || tag.name || "").toLowerCase();
      const tagLabel = tag.label || tag.name || tagSlug;
      
      // Check if this tag matches any known sport
      for (const sport of knownSports) {
        const matches = sport.searchTerms.some(term => 
          tagSlug === term || 
          tagSlug.includes(term) || 
          term.includes(tagSlug) ||
          tagLabel.toLowerCase().includes(term) ||
          term.includes(tagLabel.toLowerCase())
        );
        
        if (matches && !seenSlugs.has(sport.slug)) {
          subcategories.push({
            id: tag.id,
            label: sport.label,
            icon: '',
            slug: sport.slug,
            tagId: tag.id,
          });
          seenSlugs.add(sport.slug);
          break; // Found a match, move to next tag
        }
      }
    }

    // For sports not found in tags, add them anyway (they might still have markets)
    // We'll use the sport slug as the identifier
    for (const sport of knownSports) {
      if (!seenSlugs.has(sport.slug)) {
        // Try to find a tag ID by searching tags again with more flexible matching
        let tagId = null;
        for (const tag of tags) {
          if (!tag.id) continue;
          const tagSlug = (tag.slug || tag.label || tag.name || "").toLowerCase();
          const matches = sport.searchTerms.some(term => 
            tagSlug === term || tagSlug.includes(term) || term.includes(tagSlug)
          );
          if (matches) {
            tagId = tag.id;
            break;
          }
        }
        
        subcategories.push({
          id: sport.slug,
          label: sport.label,
          icon: '',
          slug: sport.slug,
          tagId: tagId,
        });
        seenSlugs.add(sport.slug);
      }
    }

    // Sort by label
    subcategories.sort((a, b) => a.label.localeCompare(b.label));

    console.log(`[sports-subcategories] Returning ${subcategories.length} sports subcategories`);

    return res.status(200).json({ 
      subcategories: subcategories,
      meta: { total: subcategories.length }
    });
    
  } catch (err) {
    console.error("[sports-subcategories] Error:", err.message);
    return res.status(500).json({ 
      error: "fetch_failed", 
      message: err.message,
      subcategories: [] 
    });
  }
};


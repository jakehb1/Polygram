// Test script to find all Polymarket category tag IDs
const GAMMA_API = "https://gamma-api.polymarket.com";

async function findAllCategoryTags() {
  console.log("=== Finding Polymarket Category Tag IDs ===\n");
  
  // Categories we need to map
  const categories = [
    'politics',
    'finance',
    'crypto',
    'sports',
    'tech',
    'geopolitics',
    'culture',
    'world',
    'economy',
    'breaking',
    'new'
  ];
  
  try {
    // Fetch all tags
    const tagsResp = await fetch(`${GAMMA_API}/tags`);
    if (tagsResp.ok) {
      const tags = await tagsResp.json();
      if (Array.isArray(tags)) {
        console.log(`Found ${tags.length} total tags\n`);
        
        // Find tag IDs for each category
        const categoryMappings = {};
        
        for (const category of categories) {
          const categoryLower = category.toLowerCase();
          
          // Strategy 1: Exact slug match
          const exactMatch = tags.find(tag => {
            const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
            return slug === categoryLower;
          });
          
          if (exactMatch) {
            categoryMappings[category] = {
              id: exactMatch.id,
              slug: exactMatch.slug || exactMatch.label,
              label: exactMatch.label || exactMatch.name,
              name: exactMatch.name
            };
            console.log(`✓ ${category}: ID=${exactMatch.id}, slug="${exactMatch.slug || exactMatch.label}"`);
          } else {
            // Strategy 2: Partial match
            const partialMatches = tags.filter(tag => {
              const slug = (tag.slug || tag.label || tag.name || "").toLowerCase();
              return slug.includes(categoryLower) || categoryLower.includes(slug);
            });
            
            if (partialMatches.length > 0) {
              // Take the best match (shortest slug usually means main category)
              const bestMatch = partialMatches.sort((a, b) => {
                const aSlug = (a.slug || a.label || "").length;
                const bSlug = (b.slug || b.label || "").length;
                return aSlug - bSlug;
              })[0];
              
              categoryMappings[category] = {
                id: bestMatch.id,
                slug: bestMatch.slug || bestMatch.label,
                label: bestMatch.label || bestMatch.name,
                name: bestMatch.name,
                note: `partial match (${partialMatches.length} options)`
              };
              console.log(`~ ${category}: ID=${bestMatch.id}, slug="${bestMatch.slug || bestMatch.label}" (partial match)`);
            } else {
              console.log(`✗ ${category}: No match found`);
            }
          }
        }
        
        // Also check events to see what tags are actually used
        console.log("\n=== Verifying with Events ===");
        const eventsResp = await fetch(`${GAMMA_API}/events?closed=false&limit=2000`);
        if (eventsResp.ok) {
          const events = await eventsResp.json();
          if (Array.isArray(events)) {
            // Collect all unique tags from events with their labels
            const eventTags = new Map();
            events.forEach(event => {
              (event.tags || []).forEach(tag => {
                const tagId = typeof tag === 'object' ? tag.id : tag;
                const tagLabel = typeof tag === 'object' ? (tag.label || tag.slug || '') : '';
                const tagSlug = typeof tag === 'object' ? (tag.slug || tag.label || '') : '';
                
                if (tagId && !eventTags.has(tagId)) {
                  eventTags.set(tagId, {
                    id: tagId,
                    label: tagLabel,
                    slug: tagSlug,
                    count: 0
                  });
                }
                if (tagId) {
                  const tagInfo = eventTags.get(tagId);
                  if (tagInfo) tagInfo.count++;
                }
              });
            });
            
            console.log(`\nFound ${eventTags.size} unique tags in events\n`);
            
            // Find tags that match our category names
            console.log("=== Category Tag IDs from Events ===");
            const categoryTagIds = {};
            
            for (const category of categories) {
              const categoryLower = category.toLowerCase();
              
              // Find tags that match this category
              const matchingTags = Array.from(eventTags.values())
                .filter(tag => {
                  const label = (tag.label || '').toLowerCase();
                  const slug = (tag.slug || '').toLowerCase();
                  return label === categoryLower || 
                         slug === categoryLower ||
                         label.includes(categoryLower) ||
                         slug.includes(categoryLower);
                })
                .sort((a, b) => b.count - a.count); // Sort by usage count
              
              if (matchingTags.length > 0) {
                const bestMatch = matchingTags[0];
                categoryTagIds[category] = bestMatch.id;
                console.log(`✓ ${category}: ID=${bestMatch.id}, label="${bestMatch.label}", slug="${bestMatch.slug}", used in ${bestMatch.count} events`);
              } else {
                console.log(`✗ ${category}: No matching tag found in events`);
              }
            }
            
            // Show all tags sorted by usage (top 30)
            console.log("\n=== Top Tags by Usage ===");
            const topTags = Array.from(eventTags.values())
              .sort((a, b) => b.count - a.count)
              .slice(0, 30);
            
            topTags.forEach(tag => {
              console.log(`  ID ${tag.id}: "${tag.label}" (${tag.slug}) - ${tag.count} events`);
            });
            
            // Output the mapping for code
            console.log("\n=== Code Mapping (from Events) ===");
            console.log("const knownTagIds = {");
            for (const [category, tagId] of Object.entries(categoryTagIds)) {
              const tagInfo = Array.from(eventTags.values()).find(t => t.id === tagId);
              console.log(`  '${category}': ${tagId}, // ${tagInfo?.label || tagInfo?.slug || 'unknown'}`);
            }
            console.log("};");
          }
        }
        
        // Output the mapping for code
        console.log("\n=== Code Mapping ===");
        console.log("const knownTagIds = {");
        for (const [category, mapping] of Object.entries(categoryMappings)) {
          if (mapping) {
            console.log(`  '${category}': ${mapping.id}, // ${mapping.slug || mapping.label}`);
          }
        }
        console.log("};");
        
      } else {
        console.log("Tags API returned non-array");
      }
    } else {
      console.log(`Tags API returned status: ${tagsResp.status}`);
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
  
  console.log("\n=== Complete ===");
}

findAllCategoryTags().catch(console.error);


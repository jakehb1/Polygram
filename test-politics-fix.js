// Quick test to verify Politics markets are fetched correctly
const GAMMA_API = "https://gamma-api.polymarket.com";

async function testPoliticsFix() {
  console.log("=== Testing Politics Market Fetching ===\n");
  
  // Use known tag ID 2 for Politics
  const politicsTagId = 2;
  console.log(`Using Politics tag ID: ${politicsTagId}\n`);
  
  // Fetch events and filter by Politics tag
  console.log("1. Fetching events...");
  const eventsUrl = `${GAMMA_API}/events?closed=false&order=id&ascending=false&limit=5000`;
  const eventsResp = await fetch(eventsUrl);
  
  if (eventsResp.ok) {
    const events = await eventsResp.json();
    if (Array.isArray(events)) {
      console.log(`   ✓ Found ${events.length} total events`);
      
      // Filter events with Politics tag (ID 2) - check both string and number
      const politicsEvents = events.filter(event => {
        const eventTags = event.tags || [];
        return eventTags.some(tag => {
          const tagId = typeof tag === 'object' ? tag.id : tag;
          // Check both string and number format
          return tagId === politicsTagId || tagId === String(politicsTagId) || 
                 String(tagId) === String(politicsTagId);
        });
      });
      
      // Also check what tag IDs we actually see
      const allTagIds = new Set();
      events.slice(0, 20).forEach(e => {
        (e.tags || []).forEach(tag => {
          const tagId = typeof tag === 'object' ? tag.id : tag;
          if (tagId) allTagIds.add(String(tagId));
        });
      });
      console.log(`   Sample tag IDs found in events:`, Array.from(allTagIds).slice(0, 10));
      
      console.log(`   ✓ Found ${politicsEvents.length} events with Politics tag`);
      
      // Extract markets from politics events
      let markets = [];
      for (const event of politicsEvents) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const market of event.markets) {
            if (!market.closed && market.active !== false) {
              markets.push({
                ...market,
                eventId: event.id,
                eventTitle: event.title,
                eventVolume: event.volume
              });
            }
          }
        }
      }
      
      console.log(`   ✓ Extracted ${markets.length} active markets from Politics events\n`);
      
      // Filter by volume
      const withVolume = markets.filter(m => {
        const vol = Math.max(parseFloat(m.volume24hr) || 0, parseFloat(m.volume) || 0);
        return vol > 0 && vol >= 0.01;
      });
      
      console.log(`2. Volume filtering:`);
      console.log(`   Markets with volume >= $0.01: ${withVolume.length}`);
      
      // Show top markets by volume
      const sorted = withVolume
        .map(m => ({
          question: m.question,
          volume: Math.max(parseFloat(m.volume24hr) || 0, parseFloat(m.volume) || 0),
          eventTitle: m.eventTitle
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);
      
      console.log(`\n3. Top 10 Politics markets by volume:`);
      sorted.forEach((m, i) => {
        console.log(`   ${i+1}. [$${m.volume.toLocaleString()}] ${m.question?.substring(0, 70)}...`);
      });
      
      const marketsOver1M = sorted.filter(m => m.volume >= 1000000).length;
      console.log(`\n   Markets over $1M: ${marketsOver1M}`);
    }
  } else {
    console.log(`   ✗ Error: ${eventsResp.status} ${eventsResp.statusText}`);
  }
  
  console.log("\n=== Test Complete ===");
}

testPoliticsFix().catch(console.error);


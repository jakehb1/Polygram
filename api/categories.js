// api/categories.js
// Derive a category list from current Polymarket markets,
// using the same text-based classifier as /api/markets.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function classifyMarketSlugs(market) {
  const slugs = new Set();
  const q = String(market.question || market.slug || "")
    .toLowerCase();

  const hasAny = (words) => words.some((w) => q.includes(w));

  if (
    hasAny([
      "election",
      "president",
      "prime minister",
      "parliament",
      "senate",
      "congress",
      "democrat",
      "republican",
      "biden",
      "trump",
      "harris",
      "gop",
      "labour",
      "conservative",
      "vote",
      "poll",
    ])
  ) {
    slugs.add("politics");
  }

  if (
    hasAny([
      "nba",
      "nfl",
      "mlb",
      "nhl",
      "premier league",
      "champions league",
      "world cup",
      "fifa",
      "uefa",
      "tennis",
      "wimbledon",
      "grand slam",
      "olympic",
      "super bowl",
      "finals",
      "playoffs",
      "league",
      " vs ",
      " vs.",
    ])
  ) {
    slugs.add("sports");
  }

  if (
    hasAny([
      "fed ",
      "federal reserve",
      "interest rate",
      "rate hike",
      "rate cut",
      "recession",
      "gdp",
      "inflation",
      "cpi",
      "unemployment",
      "nasdaq",
      "s&p",
      "dow jones",
      "treasury",
      "bond",
      "stock",
      "equity",
      "yield",
      "market cap",
    ])
  ) {
    slugs.add("finance");
  }

  if (
    hasAny([
      "bitcoin",
      "btc",
      "ethereum",
      "eth",
      "solana",
      "sol",
      "tether",
      "usdt",
      "stablecoin",
      "crypto",
      "token",
      "coin",
      "defi",
      "etf",
      "binance",
      "coinbase",
    ])
  ) {
    slugs.add("crypto");
  }

  if (
    hasAny([
      "war",
      "conflict",
      "invasion",
      "russia",
      "ukraine",
      "gaza",
      "israel",
      "palestine",
      "taiwan",
      "china",
      "north korea",
      "sanction",
      "nato",
      "geopolitic",
    ])
  ) {
    slugs.add("geopolitics");
  }

  if (
    hasAny([
      "global",
      "world",
      "united nations",
      "un ",
      "who ",
      "pandemic",
      "climate",
      "emissions",
      "europe",
      "asia",
      "africa",
      "latin america",
      "migration",
      "immigration",
    ])
  ) {
    slugs.add("world");
  }

  if (
    hasAny([
      "apple",
      "iphone",
      "google",
      "alphabet",
      "meta",
      "facebook",
      "amazon",
      "microsoft",
      "openai",
      "chatgpt",
      "nvidia",
      "ai ",
      "artificial intelligence",
      "chip",
      "semiconductor",
      "tesla",
      "spacex",
      "x.com",
      "social media",
      "startup",
    ])
  ) {
    slugs.add("tech");
  }

  if (
    hasAny([
      "oscars",
      "academy awards",
      "emmys",
      "grammys",
      "box office",
      "movie",
      "film",
      "tv series",
      "tv show",
      "streaming",
      "celebrity",
      "taylor swift",
      "music",
      "album",
      "tour",
      "festival",
    ])
  ) {
    slugs.add("culture");
  }

  return slugs;
}

function filterByEndDate(markets) {
  const now = Date.now();
  return markets.filter((m) => {
    const endStr = m.endDateIso || m.endDate;
    if (!endStr) return true;
    const t = Date.parse(endStr);
    if (Number.isNaN(t)) return true;
    return t >= now - ONE_DAY_MS;
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const params = new URLSearchParams();
  params.set("limit", "400");
  params.set("closed", "false");

  const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      console.error("Gamma categories error", resp.status, text);
      return res
        .status(resp.status)
        .json({ error: "gamma_error", status: resp.status });
    }

    const data = await resp.json();
    let markets = Array.isArray(data) ? data : data.markets || [];
    markets = markets.filter((m) => !m.closed && m.active !== false);
    markets = filterByEndDate(markets);

    const bucket = new Map(); // slug -> { slug, label, count }

    for (const m of markets) {
      const slugs = classifyMarketSlugs(m);
      for (const slug of slugs) {
        const existing = bucket.get(slug);
        if (existing) {
          existing.count += 1;
        } else {
          // human-readable label + emoji for each slug
          let label;
          switch (slug) {
            case "politics":
              label = "🏛️ Politics";
              break;
            case "sports":
              label = "⚽ Sports";
              break;
            case "finance":
              label = "💰 Finance";
              break;
            case "crypto":
              label = "₿ Crypto";
              break;
            case "geopolitics":
              label = "🌍 Geopolitics";
              break;
            case "world":
              label = "🌐 World";
              break;
            case "tech":
              label = "💻 Tech";
              break;
            case "culture":
              label = "🎭 Culture";
              break;
            default:
              label = slug;
          }
          bucket.set(slug, { slug, label, count: 1 });
        }
      }
    }

    const categories = Array.from(bucket.values())
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({ categories });
  } catch (err) {
    console.error("categories error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

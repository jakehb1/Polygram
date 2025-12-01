// api/markets.js
// Live Polymarket markets with local filtering.
//
// kind=new        -> newest open markets
// kind=trending   -> open markets by 24h volume desc
// kind=volume     -> open markets by total volume desc
// kind=category   -> open markets in a Polymarket category (from events)

// light time window so we don't show long-dead markets
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

  const {
    kind = "new",
    limit = "10",
    category: categorySlugRaw = "",
  } = req.query;

  const limitNum = Number(limit) || 10;
  const requestedKind = String(kind || "new").toLowerCase();
  const categorySlug = String(categorySlugRaw || "").trim().toLowerCase();

  // shared helper
  const toSlug = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");

  // filter out obviously finished markets (ended > 1 day ago)
  const filterByEndDate = (markets) => {
    const now = Date.now();
    return markets.filter((m) => {
      const endStr = m.endDateIso || m.endDate;
      if (!endStr) return true;
      const t = Date.parse(endStr);
      if (Number.isNaN(t)) return true;
      return t >= now - ONE_DAY_MS;
    });
  };

  // --- CATEGORY MODE: use Gamma /events so we obey Polymarket categories ---
  if (requestedKind === "category" && categorySlug) {
    const params = new URLSearchParams();
    params.set("limit", "200");
    params.set("closed", "false");
    const url = `https://gamma-api.polymarket.com/events?${params.toString()}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text();
        console.error("Gamma events error", resp.status, text);
        return res
          .status(resp.status)
          .json({ error: "gamma_error", status: resp.status });
      }

      const data = await resp.json();
      const events = Array.isArray(data) ? data : data.events || [];

      const collectedMarkets = [];

      for (const ev of events) {
        // does this event belong to the requested Polymarket category?
        const names = [];
        if (ev.category) names.push(ev.category);
        if (Array.isArray(ev.categories)) {
          for (const cat of ev.categories) {
            if (!cat) continue;
            if (typeof cat === "string") names.push(cat);
            else {
              if (cat.slug) names.push(cat.slug);
              if (cat.label) names.push(cat.label);
              if (cat.name) names.push(cat.name);
            }
          }
        }

        if (!names.length) continue;

        const matches = names.some((raw) => toSlug(raw) === categorySlug);
        if (!matches) continue;

        // flatten this event's markets into our list
        if (Array.isArray(ev.markets)) {
          for (const m of ev.markets) {
            if (m.closed) continue;
            collectedMarkets.push(m);
          }
        }
      }

      const filtered = filterByEndDate(collectedMarkets);

      // sort by 24h volume desc, then total volume as tie-breaker
      filtered.sort((a, b) => {
        const av24 = Number(a.volume24hr ?? 0);
        const bv24 = Number(b.volume24hr ?? 0);
        if (bv24 !== av24) return bv24 - av24;
        const av = Number(a.volumeNum ?? a.volume ?? 0);
        const bv = Number(b.volumeNum ?? b.volume ?? 0);
        return bv - av;
      });

      return res.status(200).json(filtered.slice(0, limitNum));
    } catch (err) {
      console.error("category markets error", err);
      return res.status(500).json({ error: "failed_to_fetch" });
    }
  }

  // --- DEFAULT MODES: new / trending / volume via Gamma /markets ---

  const params = new URLSearchParams();
  params.set("limit", String(Math.max(limitNum, 50)));
  params.set("closed", "false");

  if (requestedKind === "trending") {
    params.set("order", "volume24hr");
    params.set("ascending", "false");
  } else if (requestedKind === "volume") {
    params.set("order", "volumeNum");
    params.set("ascending", "false");
  } else {
    params.set("order", "createdAt");
    params.set("ascending", "false");
  }

  const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      console.error("Gamma markets error", resp.status, text);
      return res
        .status(resp.status)
        .json({ error: "gamma_error", status: resp.status });
    }

    const data = await resp.json();
    let markets = Array.isArray(data) ? data : data.markets || [];

    markets = markets.filter((m) => !m.closed);
    markets = filterByEndDate(markets);

    // they're already sorted by Gamma's order param; just enforce limit
    return res.status(200).json(markets.slice(0, limitNum));
  } catch (err) {
    console.error("markets error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

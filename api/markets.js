// api/markets.js
// Fetch open Polymarket markets from Gamma and support:
// kind=new        -> newest open markets
// kind=trending   -> open markets by 24h volume desc
// kind=volume     -> open markets by total volume desc
// kind=category   -> open markets in a category (use &category=slug)

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

  // normalize "wanted" category slug (from /api/categories or frontend)
  const normalizeSlug = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");

  const wantedCategorySlug = normalizeSlug(categorySlugRaw || "");

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("closed", "false"); // only open markets

  if (kind === "trending") {
    params.set("order", "volume24hr");
    params.set("ascending", "false");
  } else if (kind === "volume") {
    params.set("order", "volumeNum");
    params.set("ascending", "false");
  } else {
    // "new" and "category" -> newest created
    params.set("order", "createdAt");
    params.set("ascending", "false");
  }

  const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      console.error("Gamma error", resp.status, text);
      return res
        .status(resp.status)
        .json({ error: "gamma_error", status: resp.status });
    }

    const data = await resp.json();
    let markets = Array.isArray(data) ? data : data.markets || [];

    // optional category filter
    if (wantedCategorySlug) {
      markets = markets.filter((m) => {
        const candidates = [];

        // simple string category
        if (m.category) candidates.push(m.category);

        // array of categories: could be strings or objects
        if (Array.isArray(m.categories)) {
          for (const cat of m.categories) {
            if (!cat) continue;
            if (typeof cat === "string") {
              candidates.push(cat);
            } else {
              if (cat.slug) candidates.push(cat.slug);
              if (cat.label) candidates.push(cat.label);
              if (cat.name) candidates.push(cat.name);
            }
          }
        }

        if (!candidates.length) return false;

        return candidates.some(
          (c) => normalizeSlug(c) === wantedCategorySlug
        );
      });
    }

    // very light "end date" filter: drop things that clearly ended > 1 day ago
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    markets = markets.filter((m) => {
      const endStr = m.endDateIso || m.endDate || null;
      if (!endStr) return true;
      const t = Date.parse(endStr);
      if (Number.isNaN(t)) return true;
      return t >= now - ONE_DAY_MS;
    });

    const limited = markets.slice(0, Number(limit) || 10);
    return res.status(200).json(limited);
  } catch (err) {
    console.error("markets error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

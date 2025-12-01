// api/markets.js
// Fetch live-ish Polymarket markets from Gamma and do minimal local filtering.
//
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

  const categorySlug = String(categorySlugRaw || "").toLowerCase();

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  // Use Gamma's `closed` param to only request open markets 
  params.set("closed", "false");

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
    let markets = Array.isArray(data) ? data : (data.markets || []);

    // --- Optional: category filter (by slug) ---
    if (categorySlug) {
      const norm = (s) =>
        String(s || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-");

      markets = markets.filter((m) => {
        const slugs = [];

        // simple string category
        if (m.category) slugs.push(norm(m.category));

        // categories array from Gamma: [{ label, slug, ... }, ...] 
        if (Array.isArray(m.categories)) {
          for (const cat of m.categories) {
            if (!cat) continue;
            if (typeof cat === "string") {
              slugs.push(norm(cat));
            } else {
              if (cat.slug) slugs.push(norm(cat.slug));
              if (cat.label) slugs.push(norm(cat.label));
            }
          }
        }

        return slugs.includes(categorySlug);
      });
    }

    // --- Very light "obviously ended" filter: drop markets that ended >1 day ago ---
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    markets = markets.filter((m) => {
      const endStr = m.endDateIso || m.endDate || null;
      if (!endStr) return true; // no end date -> keep it
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

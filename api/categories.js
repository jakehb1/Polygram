// api/categories.js
// Derive a category list from *live-ish* Polymarket markets.
// Uses defensive filtering identical to markets.js so we only
// include categories from up-to-date markets.

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
  params.set("limit", "500"); // get a wide sample

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
    const markets = Array.isArray(data) ? data : (data.markets || []);

    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const MAX_AGE_DAYS = 365; // tolerate 1 year old markets
    const maxAgeMs = MAX_AGE_DAYS * ONE_DAY_MS;

    const currentYear = new Date().getFullYear();

    function normCategory(cat) {
      if (!cat) return "";
      return String(cat).trim().toLowerCase().replace(/\s+/g, "-");
    }

    function pickEndDate(m) {
      return (
        m.endDateIso ||
        m.endDateISO ||
        m.endDate ||
        m.endDateUtc ||
        m.endDateUTC ||
        m.closeDate ||
        m.closesAt ||
        m.expiresAt ||
        m.end_time ||
        null
      );
    }

    function pickCreatedDate(m) {
      return (
        m.createdAt ||
        m.created_at ||
        m.creationTime ||
        m.openedAt ||
        null
      );
    }

    function yearFromQuestion(m) {
      const q = String(m.question || m.title || "");
      const match = q.match(/20\d{2}/);
      if (!match) return null;
      return parseInt(match[0], 10);
    }

    const categoriesBucket = new Map();

    for (const m of markets) {
      // -------- LIVE-ish filtering (same as markets.js) --------
      if (typeof m.closed === "boolean" && m.closed) continue;
      if (typeof m.active === "boolean" && !m.active) continue;

      // end-date filter
      const endStr = pickEndDate(m);
      if (endStr) {
        const t = Date.parse(endStr);
        if (!Number.isNaN(t) && t < now - ONE_DAY_MS) continue;
      }

      // created-date filter
      const createdStr = pickCreatedDate(m);
      if (createdStr) {
        const t = Date.parse(createdStr);
        if (!Number.isNaN(t) && t < now - maxAgeMs) continue;
      }

      // year heuristic: hide obvious past-year markets
      const year = yearFromQuestion(m);
      if (year && year < currentYear) continue;

      // require some 24h activity so we don't get ghost categories
      const vol24 = Number(m.volume24hr ?? m.volume24Hrs ?? m.volume24h ?? 0);
      if (!Number.isFinite(vol24) || vol24 <= 0) continue;

      // -------- Category extraction --------
      const names = [];
      if (m.category) names.push(m.category);
      if (Array.isArray(m.categories)) names.push(...m.categories);
      if (m.categorySlug) names.push(m.categorySlug);
      if (m.category_slug) names.push(m.category_slug);

      for (const raw of names) {
        const slug = normCategory(raw);
        if (!slug) continue;

        const label = String(raw).trim();
        const existing = categoriesBucket.get(slug);
        if (existing) {
          existing.count += 1;
        } else {
          categoriesBucket.set(slug, { slug, label, count: 1 });
        }
      }
    }

    const categories = Array.from(categoriesBucket.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    return res.status(200).json({ categories });
  } catch (err) {
    console.error("categories error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

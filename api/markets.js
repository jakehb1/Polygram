// api/markets.js
// Fetch live markets from Polymarket Gamma API.
// Supports kinds:
// - new        (newest active markets)
// - trending   (active markets by 24h volume)
// - volume     (active markets by total volume)
// - sports     (active markets filtered by SPORTS tag_id from /tags)
// - tag        (active markets filtered by an explicit tag_id passed via ?tag_id=123)
//
// NOTE: Polymarket recommends tag-based filtering for categories/sports. 

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { kind = "new", limit = "20", tag_id = "" } = req.query;
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 50);

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // --- helper: resolve the Polymarket "Sports" tag id dynamically
  async function getSportsTagId() {
    const tagsResp = await fetch("https://gamma-api.polymarket.com/tags");
    if (!tagsResp.ok) throw new Error(`tags_error_${tagsResp.status}`);
    const tags = await tagsResp.json();

    // tags are objects; we match by label/name
    const sportsTag =
      tags.find((t) => String(t.label || t.name || "").toLowerCase() === "sports") ||
      tags.find((t) => String(t.slug || "").toLowerCase() === "sports");

    if (!sportsTag?.id) throw new Error("sports_tag_not_found");
    return sportsTag.id;
  }

  // --- build gamma /markets query params
  const params = new URLSearchParams();
  params.set("closed", "false");
  params.set("limit", String(Math.max(limitNum, 50))); // pull extra, then filter/limit

  if (kind === "trending") {
    params.set("order", "volume24hr");
    params.set("ascending", "false");
  } else if (kind === "volume") {
    params.set("order", "volumeNum");
    params.set("ascending", "false");
  } else {
    params.set("order", "createdAt");
    params.set("ascending", "false");
  }

  // tag filtering
  let finalTagId = tag_id;
  
  try {
    if (kind === "sports") {
      finalTagId = await getSportsTagId();
    }
  } catch (tagErr) {
    console.error("Failed to get sports tag:", tagErr);
    // Continue without tag filter
  }
  
  if ((kind === "tag" || kind === "sports") && finalTagId) {
    params.set("tag_id", String(finalTagId));
  }

  const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      console.error("Gamma markets error", resp.status, text);
      return res.status(resp.status).json({ error: "gamma_error", status: resp.status });
    }

    const data = await resp.json();
    const markets = Array.isArray(data) ? data : (data.markets || []);

    // live-ish filtering: active AND not ended more than 24h ago
    const filtered = markets.filter((m) => {
      if (m.closed === true) return false;
      if (m.active === false) return false;

      const endStr = m.endDateIso || m.endDate;
      if (endStr) {
        const t = Date.parse(endStr);
        if (!Number.isNaN(t) && t < now - ONE_DAY_MS) return false;
      }
      return true;
    });

    return res.status(200).json({ markets: filtered.slice(0, limitNum) });
  } catch (err) {
    console.error("markets error", err);
    return res.status(500).json({ error: "failed_to_fetch", markets: [] });
  }
};

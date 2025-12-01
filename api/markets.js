// api/markets.js
// Live Polymarket markets, filtered to only *upcoming / live* ones.
//
// kind=new      -> newest upcoming markets
// kind=trending -> upcoming markets by 24h volume desc
// kind=volume   -> upcoming markets by total volume desc

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

  const { kind = "new", limit = "10" } = req.query;

  const params = new URLSearchParams();
  params.set("limit", String(limit));

  // Ask Gamma for markets ordered different ways depending on "kind"
  if (kind === "trending") {
    // high 24h volume first
    params.set("order", "volume24hr");
    params.set("ascending", "false");
  } else if (kind === "volume") {
    // high all-time volume first
    params.set("order", "volumeNum");
    params.set("ascending", "false");
  } else {
    // "new" and everything else -> newest markets
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
    const markets = Array.isArray(data) ? data : (data.markets || []);

    // ---- Local filtering for *truly live* markets ----
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    const filtered = markets.filter((m) => {
      // Prefer Gamma's active/closed fields if they exist
      if (typeof m.closed === "boolean" && m.closed) return false;
      if (typeof m.active === "boolean" && !m.active) return false;

      const endStr = m.endDateIso || m.endDate;
      if (!endStr) return true; // if no end date, keep it

      const t = Date.parse(endStr);
      if (Number.isNaN(t)) return true;

      // Keep markets that end in the future, or within the last 24h (grace window)
      return t >= now - ONE_DAY_MS;
    });

    return res.status(200).json(filtered);
  } catch (err) {
    console.error("markets error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

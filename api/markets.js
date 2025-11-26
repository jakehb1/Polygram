// api/markets.js
// Proxy to Polymarket Gamma /markets endpoint with simple sorting presets.
//
// kind=new      -> newest markets by createdAt desc
// kind=trending -> markets by 24h volume desc
// kind=volume   -> markets by total volume desc

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

  // Choose sort based on kind
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
    return res.status(200).json(data);
  } catch (err) {
    console.error("markets error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

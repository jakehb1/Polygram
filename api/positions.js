const DATA_URL =
  process.env.POLYMARKET_DATA_URL || "https://data-api.polymarket.com";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { user } = req.query;
  if (!user) {
    return res.status(400).json({ error: "Missing ?user=0x... parameter" });
  }

  try {
    const url = new URL("/positions", DATA_URL);
    url.searchParams.set("user", user);
    url.searchParams.set("limit", "100");
    url.searchParams.set("sizeThreshold", "0");

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      console.error("Positions error", resp.status, text);
      return res.status(500).json({ error: "Failed to fetch positions" });
    }

    const data = await resp.json();
    return res.status(200).json({ positions: data });
  } catch (err) {
    console.error("Positions exception", err);
    return res.status(500).json({ error: "Unexpected error" });
  }
};

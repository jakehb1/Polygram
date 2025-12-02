module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const address = req.query.address;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "invalid_address" });
  }

  try {
    const resp = await fetch("https://bridge.polymarket.com/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Polymarket deposit error", text);
      return res
        .status(resp.status)
        .json({ error: "polymarket_error", details: text });
    }

    const data = await resp.json();
    return res.status(200).json(data); // { address, depositAddresses: [...] }
  } catch (err) {
    console.error("deposit error", err);
    return res.status(500).json({ error: "failed_to_create_deposit" });
  }
};

// api/trade.js
// Execute trades on Polymarket

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const body = req.body || {};
    const {
      telegram_id,
      telegramId,
      market_id,
      condition_id,
      outcome_index,
      side, // 'yes' or 'no'
      amount, // USD amount
      wallet_address
    } = body;

    const userId = telegram_id || telegramId;
    const marketId = market_id || condition_id;

    // Validation
    if (!userId) {
      return res.status(400).json({ error: "missing_user_id", message: "telegram_id is required" });
    }

    if (!marketId) {
      return res.status(400).json({ error: "missing_market_id", message: "market_id or condition_id is required" });
    }

    if (!side || !['yes', 'no'].includes(side.toLowerCase())) {
      return res.status(400).json({ error: "invalid_side", message: "side must be 'yes' or 'no'" });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "invalid_amount", message: "amount must be greater than 0" });
    }

    if (!wallet_address) {
      return res.status(400).json({ error: "missing_wallet", message: "wallet_address is required" });
    }

    console.log("[trade] Trade request:", {
      userId,
      marketId,
      side,
      amount,
      wallet_address: wallet_address.substring(0, 10) + "..."
    });

    // For MVP/testing: Simulate trade execution
    // In production, this would:
    // 1. Verify wallet has sufficient USDC balance
    // 2. Check CLOB registration
    // 3. Execute trade on Polymarket CLOB
    // 4. Record position in database

    // Simulate trade processing delay
    await new Promise(resolve => setTimeout(resolve, 500));

    // Generate a mock trade ID
    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Mock successful trade response
    return res.status(200).json({
      success: true,
      trade_id: tradeId,
      market_id: marketId,
      side: side.toLowerCase(),
      amount: parseFloat(amount),
      shares: parseFloat(amount) / 0.5, // Mock: assume 50¢ per share
      price: 0.5, // Mock price
      wallet_address: wallet_address,
      timestamp: new Date().toISOString(),
      message: "Trade executed successfully (simulated)"
    });

  } catch (err) {
    console.error("[trade] Error:", err);
    return res.status(500).json({
      error: "trade_failed",
      message: err.message
    });
  }
};


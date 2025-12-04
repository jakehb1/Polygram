// api/payout.js
// Handle payouts when positions win

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { method } = req;
  const body = req.body || {};
  const query = req.query || {};

  try {
    if (method === "GET") {
      // Get pending payouts
      const telegramId = query.telegram_id || query.telegramId;

      if (!telegramId) {
        return res.status(400).json({ error: "missing_user_id", message: "telegram_id is required" });
      }

      // In production, fetch from database
      // For now, return empty list
      return res.status(200).json({
        success: true,
        pending_payouts: [],
        total_pending: 0
      });

    } else if (method === "POST") {
      // Request payout
      const {
        telegram_id,
        telegramId,
        position_id,
        market_id,
        amount,
        wallet_address
      } = body;

      const userId = telegram_id || telegramId;

      if (!userId) {
        return res.status(400).json({ error: "missing_user_id", message: "telegram_id is required" });
      }

      if (!position_id && !market_id) {
        return res.status(400).json({ error: "missing_position", message: "position_id or market_id is required" });
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "invalid_amount", message: "Amount must be greater than 0" });
      }

      if (!wallet_address) {
        return res.status(400).json({ error: "missing_wallet", message: "wallet_address is required" });
      }

      console.log("[payout] Payout request:", {
        userId,
        position_id,
        market_id,
        amount,
        wallet_address: wallet_address.substring(0, 10) + "..."
      });

      // For MVP: Simulate payout
      // In production, this would:
      // 1. Verify position is resolved and won
      // 2. Check if payout already processed
      // 3. Transfer funds to user's wallet
      // 4. Update position status

      const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      return res.status(200).json({
        success: true,
        payout_id: payoutId,
        position_id: position_id,
        market_id: market_id,
        amount: parseFloat(amount),
        wallet_address: wallet_address,
        status: "processing",
        message: "Payout initiated. Funds will arrive in your wallet shortly.",
        estimated_time: "5-10 minutes"
      });

    } else {
      return res.status(405).json({ error: "method_not_allowed" });
    }

  } catch (err) {
    console.error("[payout] Error:", err);
    return res.status(500).json({
      error: "payout_failed",
      message: err.message
    });
  }
};


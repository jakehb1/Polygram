// api/fund.js
// Handle wallet funding (USDC and SOL deposits)

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
      // Get funding instructions/addresses
      const telegramId = query.telegram_id || query.telegramId;
      const currency = query.currency || "usdc"; // usdc or sol

      if (!telegramId) {
        return res.status(400).json({ error: "missing_user_id", message: "telegram_id is required" });
      }

      // In production, fetch wallet from database
      // For now, return instructions for manual funding
      const addresses = {
        usdc: {
          network: "Polygon",
          address: query.wallet_address || "0x0000000000000000000000000000000000000000",
          token: "USDC",
          tokenAddress: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
          minAmount: 10, // Minimum $10
          instructions: "Send USDC (Polygon network) to the address above. Minimum deposit: $10"
        },
        sol: {
          network: "Solana",
          address: query.wallet_address || "11111111111111111111111111111111",
          token: "SOL",
          minAmount: 0.1, // Minimum 0.1 SOL
          instructions: "Send SOL to the address above. Minimum deposit: 0.1 SOL"
        }
      };

      const fundingInfo = addresses[currency.toLowerCase()];
      if (!fundingInfo) {
        return res.status(400).json({ error: "invalid_currency", message: "Currency must be 'usdc' or 'sol'" });
      }

      return res.status(200).json({
        success: true,
        currency: currency.toLowerCase(),
        ...fundingInfo,
        // In production, you'd check on-chain balance here
        // For now, return the funding info
      });

    } else if (method === "POST") {
      // Initiate funding (could integrate with payment providers like Stripe, MoonPay, etc.)
      const {
        telegram_id,
        telegramId,
        currency, // 'usdc' or 'sol'
        amount,
        payment_method, // 'crypto', 'card', 'bank'
        wallet_address
      } = body;

      const userId = telegram_id || telegramId;

      if (!userId) {
        return res.status(400).json({ error: "missing_user_id", message: "telegram_id is required" });
      }

      if (!currency || !['usdc', 'sol'].includes(currency.toLowerCase())) {
        return res.status(400).json({ error: "invalid_currency", message: "Currency must be 'usdc' or 'sol'" });
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "invalid_amount", message: "Amount must be greater than 0" });
      }

      if (!wallet_address) {
        return res.status(400).json({ error: "missing_wallet", message: "wallet_address is required" });
      }

      console.log("[fund] Funding request:", {
        userId,
        currency,
        amount,
        payment_method,
        wallet_address: wallet_address.substring(0, 10) + "..."
      });

      // For MVP: Return funding instructions
      // In production, this would:
      // 1. Create a payment intent with Stripe/MoonPay/etc.
      // 2. Or generate a deposit address and monitor for incoming funds
      // 3. Update balance once funds are confirmed on-chain

      const fundingId = `fund_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      return res.status(200).json({
        success: true,
        funding_id: fundingId,
        currency: currency.toLowerCase(),
        amount: parseFloat(amount),
        wallet_address: wallet_address,
        status: "pending",
        instructions: currency.toLowerCase() === "usdc" 
          ? `Send ${amount} USDC to ${wallet_address} on Polygon network`
          : `Send ${amount} SOL to ${wallet_address} on Solana network`,
        message: "Please send funds to the address above. Your balance will update once confirmed on-chain.",
        // In production, include payment provider checkout URL if using card/bank
        checkout_url: payment_method === "card" ? null : null
      });

    } else {
      return res.status(405).json({ error: "method_not_allowed" });
    }

  } catch (err) {
    console.error("[fund] Error:", err);
    return res.status(500).json({
      error: "funding_failed",
      message: err.message
    });
  }
};


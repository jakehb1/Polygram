// api/trade.js
// Execute trades on Polymarket
// Epic 4.2: Place a Trade - with session validation and security checks

const { validateSession } = require("./middleware/validate-session");
const { checkIdempotency, storeIdempotencyKey, checkRateLimit, hashRequest } = require("./lib/security");
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    // Phase 2: Require valid session
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader?.startsWith('Bearer ') 
      ? authHeader.substring(7)
      : req.body?.session_token;

    let userId;
    if (sessionToken) {
      const sessionValidation = await validateSession(sessionToken);
      if (!sessionValidation.isValid) {
        return res.status(401).json({
          error: "invalid_session",
          message: sessionValidation.error || "Invalid or expired session"
        });
      }
      userId = sessionValidation.userId;
    } else {
      // Fallback to telegram_id for backward compatibility (deprecated)
      userId = req.body?.telegram_id || req.body?.telegramId;
      if (!userId) {
        return res.status(401).json({
          error: "authentication_required",
          message: "Session token or telegram_id required"
        });
      }
    }

    const body = req.body || {};
    const {
      market_id,
      condition_id,
      outcome_index,
      side, // 'yes' or 'no'
      amount, // USD amount
      idempotency_key,
      nonce
    } = body;

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

    // Security: Rate limiting (20 trades per minute per user)
    const rateLimit = await checkRateLimit(userId, "trade", 20, 1);
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: "rate_limit_exceeded",
        message: rateLimit.error || "Too many trade requests",
        resetAt: rateLimit.resetAt?.toISOString()
      });
    }

    // Security: Idempotency key checking
    const requestHash = hashRequest({ userId, marketId, side, amount, outcome_index });
    if (idempotency_key) {
      const idempotencyCheck = await checkIdempotency(
        idempotency_key,
        userId,
        "trade",
        requestHash,
        60 // 60 minutes TTL
      );

      if (idempotencyCheck.error) {
        return res.status(400).json({
          error: "idempotency_key_conflict",
          message: idempotencyCheck.error
        });
      }

      if (idempotencyCheck.exists && idempotencyCheck.cachedResponse) {
        return res.status(200).json(idempotencyCheck.cachedResponse);
      }
    }

    // Get user's wallet address from database
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "database_not_configured", message: "Supabase not configured" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: wallet, error: walletError } = await supabase
      .from("custody_wallets")
      .select("polygon_address")
      .eq("user_id", userId)
      .single();

    if (walletError || !wallet || !wallet.polygon_address) {
      return res.status(404).json({ error: "wallet_not_found", message: "Trading wallet not found" });
    }

    const wallet_address = wallet.polygon_address;

    // Check balance
    const { data: balance, error: balanceError } = await supabase
      .from("user_balances")
      .select("usdc_available")
      .eq("user_id", userId)
      .single();

    if (balanceError || !balance) {
      return res.status(500).json({ error: "balance_check_failed", message: "Failed to check balance" });
    }

    if (balance.usdc_available < amount) {
      return res.status(400).json({
        error: "insufficient_balance",
        message: `Insufficient balance. Available: $${balance.usdc_available.toFixed(2)}, Required: $${amount.toFixed(2)}`
      });
    }

    console.log("[trade] Trade request:", {
      userId,
      marketId,
      side,
      amount,
      wallet_address: wallet_address.substring(0, 10) + "...",
      balance: balance.usdc_available
    });

    // For MVP/testing: Simulate trade execution
    // In production, this would:
    // 1. Verify wallet has sufficient USDC balance
    // 2. Check CLOB registration
    // 3. Execute trade on Polymarket CLOB
    // 4. Record position in database

    // Simulate trade processing delay
    await new Promise(resolve => setTimeout(resolve, 500));

    // TODO: Execute actual trade on Polymarket CLOB
    // For now, simulate trade execution
    // In production, this would:
    // 1. Use signing service to sign trade transaction
    // 2. Submit to Polymarket CLOB
    // 3. Wait for confirmation
    // 4. Record position in database
    // 5. Update balance

    await new Promise(resolve => setTimeout(resolve, 500));

    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const tradeAmount = parseFloat(amount);
    const mockPrice = 0.5; // Mock price - would come from market data
    const shares = tradeAmount / mockPrice;

    // TODO: Update balance (lock funds for position)
    // For now, just return success

    const response = {
      success: true,
      trade_id: tradeId,
      market_id: marketId,
      side: side.toLowerCase(),
      amount: tradeAmount,
      shares: shares,
      price: mockPrice,
      wallet_address: wallet_address,
      timestamp: new Date().toISOString(),
      status: "pending", // Would be "confirmed" after on-chain confirmation
      message: "Trade submitted successfully"
    };

    // Store idempotency key if provided
    if (idempotency_key) {
      await storeIdempotencyKey(idempotency_key, userId, "trade", requestHash, response, 60);
    }

    return res.status(200).json(response);

  } catch (err) {
    console.error("[trade] Error:", err);
    return res.status(500).json({
      error: "trade_failed",
      message: err.message
    });
  }
};


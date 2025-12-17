// api/auth/generate-payload.js
// Phase 2: Generate payload for ton_proof authentication
// This endpoint generates a unique payload that the client signs

const crypto = require("crypto");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const telegramUserId = req.query.telegram_user_id || req.body?.telegram_user_id;

    if (!telegramUserId) {
      return res.status(400).json({
        error: "missing_user_id",
        message: "telegram_user_id is required"
      });
    }

    // Generate a unique nonce for this proof request
    const nonce = crypto.randomBytes(32).toString('base64');
    const timestamp = new Date().toISOString();

    // Create payload that will be signed
    const payload = {
      telegram_user_id: String(telegramUserId),
      timestamp: timestamp,
      nonce: nonce
    };

    // In a production system, you might want to store this nonce temporarily
    // to verify it matches when the proof is submitted (prevent replay attacks)
    // For now, we'll rely on timestamp verification

    return res.status(200).json({
      success: true,
      payload: payload,
      timestamp: timestamp
    });

  } catch (err) {
    console.error("[generate-payload] Error:", err);
    return res.status(500).json({
      error: "payload_generation_failed",
      message: err.message
    });
  }
};

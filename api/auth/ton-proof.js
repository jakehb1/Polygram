// api/auth/ton-proof.js
// Phase 2: TON Proof of Ownership Authentication
// Verifies TON wallet signature binding TON address to Telegram user ID

const { createClient } = require("@supabase/supabase-js");
const { Address } = require("@ton/core");
const { signVerify } = require("@ton/crypto");
const crypto = require("crypto");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "method_not_allowed",
      message: `Method ${req.method} not allowed`
    });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: "database_not_configured",
      message: "Supabase not configured"
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const {
      ton_address,
      telegram_user_id,
      timestamp,
      payload,
      signature,
      public_key
    } = req.body;

    // Validate required fields
    if (!ton_address || !telegram_user_id || !timestamp || !payload || !signature || !public_key) {
      return res.status(400).json({
        error: "missing_required_fields",
        message: "Missing required fields: ton_address, telegram_user_id, timestamp, payload, signature, public_key"
      });
    }

    // Get app domain from origin or environment variable
    const appDomain = process.env.APP_DOMAIN || 
                     req.headers.origin || 
                     (req.headers.referer ? new URL(req.headers.referer).hostname : 'localhost');
    
    console.log("[ton-proof] Verifying proof:", {
      ton_address,
      telegram_user_id,
      appDomain,
      timestamp
    });

    // Verify timestamp is recent (within 10 minutes to prevent replay attacks)
    const proofTimestamp = new Date(timestamp);
    const now = new Date();
    const timeDiff = Math.abs(now - proofTimestamp);
    const maxAge = 10 * 60 * 1000; // 10 minutes in milliseconds

    if (timeDiff > maxAge) {
      return res.status(400).json({
        error: "timestamp_expired",
        message: "Proof timestamp is too old (max 10 minutes)"
      });
    }

    // Construct the message for verification (ton-proof-item-v2 format)
    // Format: "ton-proof-item-v2/" + Address + AppDomain + Timestamp + Payload
    const address = Address.parse(ton_address);
    const addressBytes = address.toRawString(); // Returns address in workchain:hex format
    
    const messageParts = [
      Buffer.from("ton-proof-item-v2/", "utf-8"),
      Buffer.from(addressBytes, "utf-8"),
      Buffer.from(appDomain, "utf-8"),
      Buffer.from(timestamp.toString(), "utf-8"),
      Buffer.from(JSON.stringify(payload), "utf-8")
    ];
    
    const message = Buffer.concat(messageParts);
    
    // Hash the message using SHA-256
    const messageHash = crypto.createHash("sha256").update(message).digest();
    
    // Verify signature
    const publicKeyBuffer = Buffer.from(public_key, "base64");
    const signatureBuffer = Buffer.from(signature, "base64");
    
    const isValid = await signVerify(messageHash, signatureBuffer, publicKeyBuffer);
    
    if (!isValid) {
      return res.status(401).json({
        error: "invalid_signature",
        message: "Signature verification failed"
      });
    }

    // Verify that the payload contains the expected telegram_user_id
    if (payload.telegram_user_id !== String(telegram_user_id)) {
      return res.status(401).json({
        error: "user_id_mismatch",
        message: "Telegram user ID in payload does not match"
      });
    }

    // Verify that the ton_address matches what's stored for this user (if wallet exists)
    const { data: wallet } = await supabase
      .from("custody_wallets")
      .select("ton_address")
      .eq("user_id", String(telegram_user_id))
      .single();

    if (wallet && wallet.ton_address && wallet.ton_address !== ton_address) {
      return res.status(401).json({
        error: "address_mismatch",
        message: "TON address does not match registered address for this user"
      });
    }

    // Generate JWT session token (simplified - use proper JWT library in production)
    const sessionToken = generateSessionToken(telegram_user_id, ton_address);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Store session in database
    const { error: sessionError } = await supabase
      .from("sessions")
      .insert({
        user_id: String(telegram_user_id),
        session_token: sessionToken,
        ton_address: ton_address,
        expires_at: expiresAt.toISOString(),
        user_agent: req.headers["user-agent"] || null,
        ip_address: req.headers["x-forwarded-for"] || req.connection?.remoteAddress || null
      });

    if (sessionError) {
      console.error("[ton-proof] Session storage error:", sessionError);
      // Continue anyway - session creation failure shouldn't block auth
    }

    console.log("[ton-proof] Authentication successful:", { telegram_user_id, ton_address });

    return res.status(200).json({
      success: true,
      session_token: sessionToken,
      expires_at: expiresAt.toISOString(),
      user_id: telegram_user_id,
      ton_address: ton_address
    });

  } catch (err) {
    console.error("[ton-proof] Error:", err);
    return res.status(500).json({
      error: "verification_failed",
      message: err.message
    });
  }
};

// Generate a simple session token (use proper JWT library like jsonwebtoken in production)
function generateSessionToken(userId, tonAddress) {
  const payload = {
    user_id: userId,
    ton_address: tonAddress,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 days
  };
  
  // In production, use a proper JWT library:
  // const jwt = require('jsonwebtoken');
  // return jwt.sign(payload, process.env.JWT_SECRET);
  
  // For now, generate a secure random token
  const tokenData = JSON.stringify(payload);
  return crypto.createHash("sha256")
    .update(tokenData + process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex"))
    .digest("hex");
}

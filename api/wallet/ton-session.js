// api/wallet/ton-session.js
// TON Connect session management endpoint
// Phase 1: Session storage with encryption

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// Encryption functions (same as wallet.js)
function encrypt(text, key) {
  const algorithm = 'aes-256-cbc';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY;
  if (!key) {
    const error = new Error('ENCRYPTION_KEY environment variable is required.');
    error.code = 'ENCRYPTION_KEY_MISSING';
    throw error;
  }
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (key.length !== 64 || !hexRegex.test(key)) {
    const error = new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
    error.code = 'ENCRYPTION_KEY_INVALID';
    throw error;
  }
  return key;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: "database_not_configured",
      message: "Supabase not configured"
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const telegramId = req.body?.telegram_id || req.body?.telegramId;

  if (!telegramId) {
    return res.status(400).json({
      error: "missing_user_id",
      message: "telegram_id is required"
    });
  }

  const normalizedUserId = String(telegramId).trim();

  try {
    if (req.method === "POST") {
      // Save/update TON session
      const { ton_address, wallet_app_name, network, session_data } = req.body;

      if (!ton_address) {
        return res.status(400).json({
          error: "missing_ton_address",
          message: "ton_address is required"
        });
      }

      // Encrypt session data
      let sessionDataEnc = null;
      try {
        const encryptionKey = getEncryptionKey();
        sessionDataEnc = encrypt(JSON.stringify(session_data || {}), encryptionKey);
      } catch (encryptErr) {
        console.error("[ton-session] Encryption error:", encryptErr);
        // Continue without encryption if key not available (for development)
        sessionDataEnc = JSON.stringify(session_data || {});
      }

      // Normalize network value (TON uses -239 for mainnet, -3 for testnet)
      let normalizedNetwork = network || 'mainnet';
      if (normalizedNetwork === '-239' || normalizedNetwork === 'mainnet') {
        normalizedNetwork = 'mainnet';
      } else if (normalizedNetwork === '-3' || normalizedNetwork === 'testnet') {
        normalizedNetwork = 'testnet';
      }

      // Update custody_wallets table with TON session data
      const { data, error } = await supabase
        .from("custody_wallets")
        .update({
          ton_address: ton_address.trim(),
          ton_wallet_app_name: wallet_app_name || null,
          ton_network: normalizedNetwork,
          tonconnect_session_data_enc: sessionDataEnc,
          ton_session_connected_at: new Date().toISOString()
        })
        .eq("user_id", normalizedUserId)
        .select("ton_address, ton_wallet_app_name, ton_network, ton_session_connected_at")
        .single();

      if (error) {
        // If wallet doesn't exist, create it (shouldn't happen, but handle gracefully)
        if (error.code === 'PGRST116') {
          return res.status(404).json({
            error: "wallet_not_found",
            message: "Wallet not found. Please create wallet first."
          });
        }
        throw error;
      }

      return res.status(200).json({
        success: true,
        session: {
          ton_address: data.ton_address,
          wallet_app_name: data.ton_wallet_app_name,
          network: data.ton_network,
          connected_at: data.ton_session_connected_at
        }
      });

    } else if (req.method === "DELETE") {
      // Clear TON session
      const { data, error } = await supabase
        .from("custody_wallets")
        .update({
          tonconnect_session_data_enc: null,
          ton_session_connected_at: null
          // Keep ton_address, ton_wallet_app_name, ton_network for reconnection
        })
        .eq("user_id", normalizedUserId)
        .select("ton_address")
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return res.status(200).json({
        success: true,
        message: "Session cleared"
      });
    } else {
      return res.status(405).json({
        error: "method_not_allowed",
        message: `Method ${req.method} not allowed`
      });
    }
  } catch (err) {
    console.error("[ton-session] Error:", err);
    return res.status(500).json({
      error: "session_operation_failed",
      message: err.message
    });
  }
};

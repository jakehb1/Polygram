// api/wallet.js
// Wallet generation and management with Supabase

const { Wallet } = require("@ethersproject/wallet");
const { Keypair } = require("@solana/web3.js");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// Simple encryption for MVP (use proper encryption in production)
function encrypt(text, key) {
  const algorithm = 'aes-256-cbc';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText, key) {
  const algorithm = 'aes-256-cbc';
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key, 'hex'), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Generate encryption key from environment
// CRITICAL: Must be set in production or wallets cannot be decrypted!
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY;
  if (!key) {
    const error = new Error('ENCRYPTION_KEY environment variable is required. Set it in Vercel environment variables.');
    error.code = 'ENCRYPTION_KEY_MISSING';
    throw error;
  }
  // Ensure key is 64 hex characters (32 bytes)
  // Also check if it's valid hex
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (key.length !== 64) {
    const error = new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate with: openssl rand -hex 32');
    error.code = 'ENCRYPTION_KEY_INVALID_LENGTH';
    throw error;
  }
  if (!hexRegex.test(key)) {
    const error = new Error('ENCRYPTION_KEY must contain only hexadecimal characters (0-9, a-f). Generate with: openssl rand -hex 32');
    error.code = 'ENCRYPTION_KEY_INVALID_FORMAT';
    throw error;
  }
  return key;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const hasSupabase = SUPABASE_URL && SUPABASE_SERVICE_KEY;

  const telegramId = req.query.telegram_id || req.query.telegramId || req.body?.telegram_id || req.body?.telegramId;

  if (!telegramId) {
    return res.status(400).json({ 
      error: "missing_user_id", 
      message: "telegram_id is required" 
    });
  }

  try {
    // If Supabase is configured, use it
    if (hasSupabase) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      
      // Check if wallet already exists
      const { data: existingWallet, error: fetchError } = await supabase
        .from("custody_wallets")
        .select("polygon_address, solana_address, created_at")
        .eq("user_id", String(telegramId))
        .single();

      if (existingWallet && !fetchError) {
        console.log("[wallet] Found existing wallet for user:", telegramId);
        return res.status(200).json({
          success: true,
          wallet: {
            solana: existingWallet.solana_address,
            polygon: existingWallet.polygon_address,
            userId: telegramId,
            createdAt: existingWallet.created_at,
          },
          isNew: false,
        });
      }

      // Generate new wallets
      console.log("[wallet] Creating new wallets for user:", telegramId);
      
      // Generate Polygon wallet (Ethereum-compatible)
      const polygonWallet = Wallet.createRandom();
      
      // Generate Solana wallet (valid keypair)
      const solanaKeypair = Keypair.generate();
      const solanaAddress = solanaKeypair.publicKey.toBase58();
      const solanaSecretKey = Buffer.from(solanaKeypair.secretKey).toString('base64');

      // Encrypt private keys
      const encryptionKey = getEncryptionKey();
      const polygonSecretEnc = encrypt(polygonWallet.privateKey, encryptionKey);
      const solanaSecretEnc = encrypt(solanaSecretKey, encryptionKey);

      // Save to Supabase
      const { data: newWallet, error: insertError } = await supabase
        .from("custody_wallets")
        .insert({
          user_id: String(telegramId),
          polygon_address: polygonWallet.address.toLowerCase(),
          polygon_secret_enc: polygonSecretEnc,
          solana_address: solanaAddress,
          solana_secret_enc: solanaSecretEnc,
          clob_registered: false,
          usdc_approved: false,
        })
        .select("polygon_address, solana_address, created_at")
        .single();

      if (insertError) {
        console.error("[wallet] Supabase insert error:", insertError);
        throw new Error(`Failed to save wallet: ${insertError.message}`);
      }

      // Initialize balance record
      await supabase
        .from("user_balances")
        .upsert({
          user_id: String(telegramId),
          usdc_available: 0,
          usdc_locked: 0,
          sol_balance: 0,
        }, {
          onConflict: 'user_id'
        });

      console.log("[wallet] Successfully created wallets for user:", telegramId);

      return res.status(200).json({
        success: true,
        wallet: {
          solana: newWallet.solana_address,
          polygon: newWallet.polygon_address,
          userId: telegramId,
          createdAt: newWallet.created_at,
        },
        isNew: true,
      });
    } else {
      // Fallback: Generate wallets without Supabase (for development/testing)
      console.log("[wallet] Supabase not configured, generating wallets without persistence");
      
      // Generate Polygon wallet (Ethereum-compatible)
      const polygonWallet = Wallet.createRandom();
      
      // Generate Solana wallet (valid keypair)
      const solanaKeypair = Keypair.generate();
      const solanaAddress = solanaKeypair.publicKey.toBase58();

      return res.status(200).json({
        success: true,
        wallet: {
          solana: solanaAddress,
          polygon: polygonWallet.address.toLowerCase(),
          userId: telegramId,
          createdAt: new Date().toISOString(),
        },
        isNew: true,
        warning: "Wallets generated without persistence. Configure Supabase for wallet persistence."
      });
    }

  } catch (err) {
    console.error("[wallet] Error:", err);
    
    // Provide more helpful error messages
    if (err.code === 'ENCRYPTION_KEY_MISSING' || err.code === 'ENCRYPTION_KEY_INVALID_LENGTH' || err.code === 'ENCRYPTION_KEY_INVALID_FORMAT') {
      return res.status(500).json({ 
        error: "encryption_key_error", 
        message: err.message,
        code: err.code,
        help: "Generate a valid key with: openssl rand -hex 32"
      });
    }
    
    return res.status(500).json({ 
      error: "wallet_creation_failed", 
      message: err.message 
    });
  }
};

// api/wallet.js
// Wallet generation and management with Supabase
// Phase 3: Migrating to Supabase Vault for key storage

const { Wallet } = require("@ethersproject/wallet");
const { Keypair } = require("@solana/web3.js");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
// TODO: Import Vault functions when Vault API is fully integrated
// const { createVaultSecret, getVaultSecret } = require("./lib/vault");

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

  // Normalize user ID to string and validate
  const normalizedUserId = String(telegramId).trim();
  if (!normalizedUserId || normalizedUserId.length === 0) {
    return res.status(400).json({ 
      error: "invalid_user_id", 
      message: "telegram_id cannot be empty" 
    });
  }

  console.log("[wallet] Processing request for Telegram user ID:", normalizedUserId);

  try {
    // If Supabase is configured, use it
    if (hasSupabase) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      
      // Check if wallet already exists for this Telegram user
      const { data: existingWallet, error: fetchError } = await supabase
        .from("custody_wallets")
        .select("polygon_address, solana_address, ton_address, created_at, user_id")
        .eq("user_id", normalizedUserId)
        .single();

      if (existingWallet && !fetchError) {
        console.log("[wallet] Found existing wallet for Telegram user:", normalizedUserId);
        console.log("[wallet] Wallet addresses - Polygon:", existingWallet.polygon_address, "Solana:", existingWallet.solana_address, "TON:", existingWallet.ton_address || "not connected");
        
        // Handle POST request to update TON address (when user connects via TON Connect)
        if (req.method === "POST" && req.body?.ton_address) {
          const tonAddress = req.body.ton_address.trim();
          console.log("[wallet] Updating TON address for user:", normalizedUserId, "Address:", tonAddress);
          
          const { data: updatedWallet, error: updateError } = await supabase
            .from("custody_wallets")
            .update({ ton_address: tonAddress })
            .eq("user_id", normalizedUserId)
            .select("polygon_address, solana_address, ton_address, created_at, user_id")
            .single();
          
          if (updateError) {
            console.error("[wallet] Error updating TON address:", updateError);
            return res.status(500).json({
              error: "ton_address_update_failed",
              message: updateError.message
            });
          }
          
          return res.status(200).json({
            success: true,
            wallet: {
              solana: updatedWallet.solana_address,
              polygon: updatedWallet.polygon_address,
              ton: updatedWallet.ton_address,
              userId: normalizedUserId,
              createdAt: updatedWallet.created_at,
            },
            isNew: false,
            tonAddressUpdated: true,
          });
        }
        
        return res.status(200).json({
          success: true,
          wallet: {
            solana: existingWallet.solana_address,
            polygon: existingWallet.polygon_address,
            ton: existingWallet.ton_address || null,
            userId: normalizedUserId,
            createdAt: existingWallet.created_at,
          },
          isNew: false,
        });
      }

      // Generate new wallets for this Telegram user
      console.log("[wallet] Creating new wallets for Telegram user:", normalizedUserId);
      
      // Generate Polygon wallet (Ethereum-compatible)
      const polygonWallet = Wallet.createRandom();
      
      // Generate Solana wallet (valid keypair)
      const solanaKeypair = Keypair.generate();
      const solanaAddress = solanaKeypair.publicKey.toBase58();
      const solanaSecretKey = Buffer.from(solanaKeypair.secretKey).toString('base64');

      // Encrypt private keys (requires ENCRYPTION_KEY)
      let encryptionKey;
      let encryptionError = null;
      try {
        encryptionKey = getEncryptionKey();
      } catch (encryptErr) {
        console.error("[wallet] Encryption key error:", encryptErr);
        encryptionError = encryptErr;
        // Don't fail immediately - we'll handle this below
      }
      
      // If encryption key is missing, we can't save to Supabase securely
      if (encryptionError) {
        // Still generate wallets so user can see them, but warn about persistence
        console.warn("[wallet] Encryption key missing - wallets generated but not persisted");
        return res.status(200).json({
          success: true,
          wallet: {
            solana: solanaAddress,
            polygon: polygonWallet.address.toLowerCase(),
            userId: normalizedUserId,
            createdAt: new Date().toISOString(),
          },
          isNew: true,
          warning: "Wallets generated but not saved. ENCRYPTION_KEY must be configured in Vercel to persist wallets.",
          error: "encryption_key_missing",
          help: "Set ENCRYPTION_KEY environment variable in Vercel. Generate with: openssl rand -hex 32"
        });
      }
      
      // Phase 3: Store keys in Vault (when fully integrated) or encrypted storage (fallback)
      // TODO: Replace with Vault storage once Supabase Vault API is integrated
      let polygonVaultSecretId = null;
      let solanaVaultSecretId = null;
      
      // Try to use Vault if available (future implementation)
      const USE_VAULT = process.env.USE_VAULT === 'true';
      
      if (USE_VAULT) {
        try {
          // TODO: Uncomment when Vault integration is complete
          // const { createVaultSecret } = require("./lib/vault");
          // polygonVaultSecretId = await createVaultSecret(
          //   `polygon_${normalizedUserId}`,
          //   polygonWallet.privateKey,
          //   `Polygon private key for user ${normalizedUserId}`
          // );
          // solanaVaultSecretId = await createVaultSecret(
          //   `solana_${normalizedUserId}`,
          //   solanaSecretKey,
          //   `Solana private key for user ${normalizedUserId}`
          // );
          console.log("[wallet] Vault storage not yet implemented, using encrypted storage");
        } catch (vaultError) {
          console.warn("[wallet] Vault storage failed, falling back to encrypted storage:", vaultError);
        }
      }

      // Fallback: Use encrypted storage (current implementation)
      // NOTE: This is temporary - keys should be moved to Vault
      const polygonSecretEnc = encrypt(polygonWallet.privateKey, encryptionKey);
      const solanaSecretEnc = encrypt(solanaSecretKey, encryptionKey);

      // Save to Supabase with Telegram user ID
      // Note: TON address is set separately when user connects via TON Connect (not custodial)
      const insertData = {
        user_id: normalizedUserId, // Store Telegram user ID
        polygon_address: polygonWallet.address.toLowerCase(),
        solana_address: solanaAddress,
        ton_address: null, // Will be set when user connects via TON Connect
        clob_registered: false,
        usdc_approved: false,
      };

      // Phase 3: Use Vault secret IDs if available, otherwise use encrypted storage
      if (polygonVaultSecretId && solanaVaultSecretId) {
        insertData.polygon_vault_secret_id = polygonVaultSecretId;
        insertData.solana_vault_secret_id = solanaVaultSecretId;
        // Don't store encrypted keys if using Vault
      } else {
        // Use encrypted storage (current method)
        insertData.polygon_secret_enc = polygonSecretEnc;
        insertData.solana_secret_enc = solanaSecretEnc;
      }

      const { data: newWallet, error: insertError } = await supabase
        .from("custody_wallets")
        .insert(insertData)
        .select("polygon_address, solana_address, ton_address, created_at, user_id")
        .single();

      if (insertError) {
        console.error("[wallet] Supabase insert error:", insertError);
        // Check if it's a duplicate key error (user already has wallet)
        if (insertError.code === '23505' || insertError.message.includes('duplicate') || insertError.message.includes('unique')) {
          console.log("[wallet] Wallet already exists, fetching existing wallet");
          // Try to fetch the existing wallet
          const { data: existing } = await supabase
            .from("custody_wallets")
            .select("polygon_address, solana_address, created_at")
            .eq("user_id", normalizedUserId)
            .single();
          
          if (existing) {
            return res.status(200).json({
              success: true,
              wallet: {
                solana: existing.solana_address,
                polygon: existing.polygon_address,
                userId: normalizedUserId,
                createdAt: existing.created_at,
              },
              isNew: false,
            });
          }
        }
        throw new Error(`Failed to save wallet: ${insertError.message}`);
      }

      // Initialize balance record for this Telegram user
      const { error: balanceError } = await supabase
        .from("user_balances")
        .upsert({
          user_id: normalizedUserId, // Store Telegram user ID
          usdc_available: 0,
          usdc_locked: 0,
          sol_balance: 0,
          ton_balance: 0, // TON balance (will be updated via bridge transactions)
        }, {
          onConflict: 'user_id'
        });

      if (balanceError) {
        console.error("[wallet] Balance initialization error:", balanceError);
        // Don't fail wallet creation if balance init fails
      }

      console.log("[wallet] Successfully created wallets for Telegram user:", normalizedUserId);
      console.log("[wallet] Wallet addresses - Polygon:", newWallet.polygon_address, "Solana:", newWallet.solana_address);

      return res.status(200).json({
        success: true,
        wallet: {
          solana: newWallet.solana_address,
          polygon: newWallet.polygon_address,
          ton: newWallet.ton_address || null,
          userId: normalizedUserId,
          createdAt: newWallet.created_at,
        },
        isNew: true,
      });
    } else {
      // Fallback: Generate wallets without Supabase (for development/testing)
      // NOTE: This doesn't require encryption key since we're not storing anything
      console.log("[wallet] Supabase not configured, generating wallets without persistence");
      
      try {
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
            userId: normalizedUserId,
            createdAt: new Date().toISOString(),
          },
          isNew: true,
          warning: "Wallets generated without persistence. Configure Supabase for wallet persistence."
        });
      } catch (err) {
        console.error("[wallet] Error generating wallets (fallback):", err);
        return res.status(500).json({
          error: "wallet_generation_failed",
          message: err.message
        });
      }
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

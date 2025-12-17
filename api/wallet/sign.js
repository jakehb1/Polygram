// api/wallet/sign.js
// Phase 3: Server-side signing service for EVM transactions
// This endpoint signs transactions using keys stored in Vault (or encrypted storage)

const { Wallet } = require("@ethersproject/wallet");
const { Keypair } = require("@solana/web3.js");
const { createClient } = require("@supabase/supabase-js");
const { validateSession } = require("../middleware/validate-session");
const crypto = require("crypto");

// Encryption functions (temporary - for retrieving keys from encrypted storage)
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

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters');
  }
  return key;
}

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

  // Phase 2: Require valid session
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith('Bearer ') 
    ? authHeader.substring(7)
    : req.body?.session_token;

  if (!sessionToken) {
    return res.status(401).json({
      error: "authentication_required",
      message: "Session token required"
    });
  }

  const sessionValidation = await validateSession(sessionToken);
  if (!sessionValidation.isValid) {
    return res.status(401).json({
      error: "invalid_session",
      message: sessionValidation.error || "Invalid or expired session"
    });
  }

  const userId = sessionValidation.userId;

  try {
    const {
      network, // 'polygon' or 'solana'
      transaction, // Transaction data to sign
      nonce, // Request nonce for replay protection
      idempotency_key // Idempotency key for duplicate request prevention
    } = req.body;

    // Phase 7: Policy checks
    if (!network || !transaction) {
      return res.status(400).json({
        error: "missing_required_fields",
        message: "network and transaction are required"
      });
    }

    // TODO: Implement nonce validation (prevent replay attacks)
    // TODO: Implement idempotency key checking (prevent duplicate requests)
    // TODO: Implement rate limiting
    // TODO: Implement amount limits and risk checks

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        error: "database_not_configured",
        message: "Supabase not configured"
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Get wallet for user
    const { data: wallet, error: walletError } = await supabase
      .from("custody_wallets")
      .select("polygon_address, polygon_secret_enc, polygon_vault_secret_id, solana_address, solana_secret_enc, solana_vault_secret_id")
      .eq("user_id", userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({
        error: "wallet_not_found",
        message: "Wallet not found for user"
      });
    }

    let privateKey;

    if (network === 'polygon') {
      // Retrieve private key from Vault or encrypted storage
      if (wallet.polygon_vault_secret_id) {
        // TODO: Retrieve from Vault
        // const { getVaultSecret } = require("../lib/vault");
        // privateKey = await getVaultSecret(wallet.polygon_vault_secret_id);
        return res.status(501).json({
          error: "vault_not_implemented",
          message: "Vault retrieval not yet implemented"
        });
      } else if (wallet.polygon_secret_enc) {
        // Fallback: Use encrypted storage
        const encryptionKey = getEncryptionKey();
        privateKey = decrypt(wallet.polygon_secret_enc, encryptionKey);
      } else {
        return res.status(500).json({
          error: "key_not_found",
          message: "Private key not found for Polygon wallet"
        });
      }

      // Sign transaction using ethers.js
      const walletInstance = new Wallet(privateKey);
      // TODO: Implement actual transaction signing based on transaction data
      // This is a placeholder - implement based on your transaction structure
      const signedTx = await walletInstance.signTransaction(transaction);

      return res.status(200).json({
        success: true,
        signed_transaction: signedTx,
        network: 'polygon'
      });

    } else if (network === 'solana') {
      // Retrieve private key from Vault or encrypted storage
      if (wallet.solana_vault_secret_id) {
        // TODO: Retrieve from Vault
        return res.status(501).json({
          error: "vault_not_implemented",
          message: "Vault retrieval not yet implemented"
        });
      } else if (wallet.solana_secret_enc) {
        // Fallback: Use encrypted storage
        const encryptionKey = getEncryptionKey();
        const secretKeyBase64 = decrypt(wallet.solana_secret_enc, encryptionKey);
        const secretKey = Buffer.from(secretKeyBase64, 'base64');
        const keypair = Keypair.fromSecretKey(secretKey);
        
        // TODO: Implement actual transaction signing for Solana
        // This is a placeholder
        return res.status(200).json({
          success: true,
          signed_transaction: "Solana signing not yet implemented",
          network: 'solana'
        });
      } else {
        return res.status(500).json({
          error: "key_not_found",
          message: "Private key not found for Solana wallet"
        });
      }
    } else {
      return res.status(400).json({
        error: "unsupported_network",
        message: "Unsupported network. Use 'polygon' or 'solana'"
      });
    }

  } catch (err) {
    console.error("[wallet/sign] Error:", err);
    return res.status(500).json({
      error: "signing_failed",
      message: err.message
    });
  }
};

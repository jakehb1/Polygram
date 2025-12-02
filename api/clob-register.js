// api/clob-register.js
// Register a wallet with Polymarket CLOB to get API credentials
// This is required before a wallet can place orders

const { Wallet } = require("@ethersproject/wallet");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.CLOB_CHAIN_ID || 137);

// Import encryption from wallet.js
const { decrypt, encrypt } = require("./wallet.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const { telegram_id, telegramId } = req.body || {};
  const tgId = telegram_id || telegramId;

  if (!tgId) {
    return res.status(400).json({ error: "Missing telegram_id" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Get wallet from Supabase
    const { data: walletData, error: fetchError } = await supabase
      .from("custody_wallets")
      .select("*")
      .eq("user_id", String(tgId))
      .single();

    if (fetchError || !walletData) {
      return res.status(404).json({ error: "Wallet not found. Create one first." });
    }

    // Check if already registered
    if (walletData.clob_registered && walletData.clob_api_key_enc) {
      return res.status(200).json({
        success: true,
        message: "Already registered with CLOB",
        address: walletData.polygon_address,
      });
    }

    // Decrypt private key
    const privateKey = decrypt(walletData.polygon_secret_enc);
    const wallet = new Wallet(privateKey);

    // Import CLOB client
    const { ClobClient } = await import("@polymarket/clob-client");

    // Create client without credentials (for registration)
    const client = new ClobClient(HOST, CHAIN_ID, wallet);

    // Create or derive API credentials
    // The CLOB client derives credentials from a wallet signature
    const creds = await client.createOrDeriveApiKey();

    if (!creds || !creds.apiKey || !creds.secret || !creds.passphrase) {
      return res.status(500).json({ error: "Failed to derive API credentials" });
    }

    // Store credentials in Supabase (encrypted)
    const { error: updateError } = await supabase
      .from("custody_wallets")
      .update({
        clob_registered: true,
        clob_api_key_enc: encrypt(creds.apiKey),
        clob_api_secret_enc: encrypt(creds.secret),
        clob_api_passphrase_enc: encrypt(creds.passphrase),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", String(tgId));

    if (updateError) {
      console.error("Failed to save CLOB credentials:", updateError);
      return res.status(500).json({ error: "Failed to save credentials" });
    }

    return res.status(200).json({
      success: true,
      message: "Successfully registered with Polymarket CLOB",
      address: walletData.polygon_address,
    });
  } catch (err) {
    console.error("CLOB registration error:", err);
    return res.status(500).json({
      error: "Registration failed",
      details: err.message,
    });
  }
};

// api/trade.js
// Execute trades on Polymarket CLOB using custodial wallets from Supabase

const { Wallet } = require("@ethersproject/wallet");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.CLOB_CHAIN_ID || 137);

// Simple encryption (same as wallet.js - in production, share via module)
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || "default-key-change-me";

function decrypt(encoded) {
  const key = ENCRYPTION_KEY;
  const text = Buffer.from(encoded, "base64").toString();
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(
      text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }
  return result;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  // Check Supabase config
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Database not configured" });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const {
    telegram_id,
    telegramId,
    tokenId,
    side,
    price,
    size,
    tickSize = "0.001",
    negRisk = false,
  } = body || {};

  const tgId = telegram_id || telegramId;

  if (!tgId) {
    return res.status(400).json({ error: "Missing telegram_id" });
  }

  if (!tokenId || !side || price == null || size == null) {
    return res.status(400).json({
      error: "Required: tokenId, side, price, size",
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Fetch wallet from Supabase
    const { data: walletData, error: fetchError } = await supabase
      .from("custody_wallets")
      .select("*")
      .eq("user_id", String(tgId))
      .single();

    if (fetchError || !walletData) {
      return res.status(404).json({ error: "Wallet not found. Create one first." });
    }

    // Check if CLOB registered
    if (!walletData.clob_registered || !walletData.clob_api_key_enc) {
      return res.status(400).json({
        error: "Wallet not registered with CLOB. Call /api/clob-register first.",
        needsRegistration: true,
      });
    }

    // Decrypt credentials
    const privateKey = decrypt(walletData.polygon_secret_enc);
    const apiKey = decrypt(walletData.clob_api_key_enc);
    const apiSecret = decrypt(walletData.clob_api_secret_enc);
    const apiPassphrase = decrypt(walletData.clob_api_passphrase_enc);

    // Create wallet signer
    const signer = new Wallet(privateKey);

    // Import CLOB client
    const { ClobClient, Side, OrderType } = await import("@polymarket/clob-client");

    // Create authenticated client
    // Note: ClobClient accepts creds as 4th param with { key, secret, passphrase } format
    const creds = {
      key: apiKey,        // This is the apiKey from createOrDeriveApiKey()
      secret: apiSecret,
      passphrase: apiPassphrase,
    };

    // signatureType 0 = EOA (direct wallet), 1 = Magic/Email, 2 = Browser wallet
    const client = new ClobClient(
      HOST,
      CHAIN_ID,
      signer,
      creds,
      0, // signatureType (0 = EOA for server-side custodial)
      walletData.polygon_address // funder address (where USDC is held)
    );

    // Determine order side
    const orderSide = side === "SELL" ? Side.SELL : Side.BUY;

    // Create and post order
    const resp = await client.createAndPostOrder(
      {
        tokenID: String(tokenId),
        price: Number(price),
        size: Number(size),
        side: orderSide,
      },
      { tickSize: String(tickSize), negRisk: !!negRisk },
      OrderType.GTC
    );

    // Log trade to Supabase trades table
    await supabase.from("trades").insert({
      user_id: String(tgId),
      market_slug: body.marketSlug || null,
      clob_token_id: String(tokenId),
      side: side,
      price: Number(price),
      size: Number(size),
      order_id: resp?.orderID || resp?.id || null,
      status: "posted",
      raw: resp,
      created_at: new Date().toISOString(),
    }).catch(e => console.error("Failed to log trade:", e));

    return res.status(200).json({
      success: true,
      orderId: resp?.orderID || resp?.id,
      result: resp,
    });
  } catch (err) {
    console.error("Trade error:", err);

    // Handle specific CLOB errors
    if (err.message?.includes("insufficient")) {
      return res.status(400).json({
        error: "Insufficient balance",
        details: err.message,
      });
    }

    if (err.message?.includes("allowance")) {
      return res.status(400).json({
        error: "Token allowance not set. Need to approve USDC spending.",
        details: err.message,
        needsApproval: true,
      });
    }

    return res.status(500).json({
      error: "Failed to place order",
      details: err.message,
    });
  }
};

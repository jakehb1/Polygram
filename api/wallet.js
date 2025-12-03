// api/wallet.js
// Custodial wallet management with Supabase

const { Wallet } = require("@ethersproject/wallet");
const { createClient } = require("@supabase/supabase-js");

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || "default-key-change-me-32chars!!";

function encrypt(text) {
  const key = ENCRYPTION_KEY;
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(result).toString("base64");
}

function decrypt(encoded) {
  const key = ENCRYPTION_KEY;
  const text = Buffer.from(encoded, "base64").toString();
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

// Generate a random Solana-like address (44 chars base58)
function generateSolanaAddress() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 44; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing Supabase config");
    return res.status(500).json({ error: "Database not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const telegramId = req.query.telegram_id || req.body?.telegram_id || req.query.telegramId || req.body?.telegramId;

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegram_id" });
  }

  try {
    return await getOrCreateWallet(supabase, telegramId, res);
  } catch (err) {
    console.error("Wallet API error:", err);
    return res.status(500).json({ error: err.message });
  }
};

async function getOrCreateWallet(supabase, telegramId, res) {
  console.log("[wallet] Getting/creating wallet for:", telegramId);
  
  // Check if wallet exists
  const { data: existing, error: fetchError } = await supabase
    .from("custody_wallets")
    .select("*")
    .eq("user_id", String(telegramId))
    .single();

  if (fetchError && fetchError.code !== "PGRST116") {
    console.error("Supabase fetch error:", fetchError);
    return res.status(500).json({ error: "Database error", details: fetchError.message });
  }

  if (existing) {
    console.log("[wallet] Found existing wallet");
    return res.status(200).json({
      success: true,
      wallet: {
        solana: existing.solana_address || null,
        polygon: existing.polygon_address,
        userId: existing.user_id,
        createdAt: existing.created_at,
        clobRegistered: existing.clob_registered || false,
        usdcApproved: existing.usdc_approved || false,
      },
      isNew: false,
    });
  }

  console.log("[wallet] Creating new wallet...");

  // Create new Polygon wallet (for USDC/Polymarket)
  const polygonWallet = Wallet.createRandom();
  const encryptedPolygonPk = encrypt(polygonWallet.privateKey);

  // Generate Solana address (simple random for demo, real app would use @solana/web3.js)
  const solanaAddress = generateSolanaAddress();
  const encryptedSolanaPk = encrypt("demo-solana-key-" + solanaAddress);

  // Try to insert with Solana fields, fall back to without if columns don't exist
  let inserted = null;
  let insertError = null;

  // First try with Solana columns
  const fullRecord = {
    user_id: String(telegramId),
    polygon_address: polygonWallet.address.toLowerCase(),
    polygon_secret_enc: encryptedPolygonPk,
    solana_address: solanaAddress,
    solana_secret_enc: encryptedSolanaPk,
    clob_registered: false,
    usdc_approved: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result1 = await supabase
    .from("custody_wallets")
    .insert(fullRecord)
    .select()
    .single();

  if (result1.error) {
    console.log("[wallet] Full insert failed, trying without Solana columns:", result1.error.message);
    
    // Try without Solana columns (in case they don't exist)
    const minimalRecord = {
      user_id: String(telegramId),
      polygon_address: polygonWallet.address.toLowerCase(),
      polygon_secret_enc: encryptedPolygonPk,
      clob_registered: false,
      usdc_approved: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result2 = await supabase
      .from("custody_wallets")
      .insert(minimalRecord)
      .select()
      .single();

    inserted = result2.data;
    insertError = result2.error;
  } else {
    inserted = result1.data;
    insertError = result1.error;
  }

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return res.status(500).json({ error: "Failed to create wallet", details: insertError.message });
  }

  console.log("[wallet] Wallet created successfully");

  // Try to create user_balances entry (optional)
  await supabase.from("user_balances").upsert({
    user_id: String(telegramId),
    usdc_available: 0,
    usdc_locked: 0,
    updated_at: new Date().toISOString(),
  }).catch(e => console.error("Balance entry error:", e));

  return res.status(201).json({
    success: true,
    wallet: {
      solana: inserted.solana_address || solanaAddress,
      polygon: inserted.polygon_address,
      userId: inserted.user_id,
      createdAt: inserted.created_at,
      clobRegistered: false,
      usdcApproved: false,
    },
    isNew: true,
  });
}

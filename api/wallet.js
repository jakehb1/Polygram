// api/wallet.js
// Custodial wallet management with Supabase
// Creates/retrieves Polygon wallets per Telegram user

const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { formatUnits } = require("ethers/lib/utils");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service key for server-side

// Encrypt private keys before storing (simple XOR for demo - use proper encryption in production!)
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || "default-key-change-me";

function encrypt(text) {
  // In production, use proper AES-256-GCM encryption
  const key = ENCRYPTION_KEY;
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(
      text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }
  return Buffer.from(result).toString("base64");
}

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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Get telegram user ID from query or body
  const telegramId =
    req.query.telegram_id ||
    req.body?.telegram_id ||
    req.query.telegramId ||
    req.body?.telegramId;

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegram_id parameter" });
  }

  const action = req.query.action || req.body?.action || "get";

  try {
    switch (action) {
      case "get":
      case "create":
        return await getOrCreateWallet(supabase, telegramId, res);
      case "balance":
        return await getWalletBalance(supabase, telegramId, res);
      case "export":
        // Security: Only allow with additional verification in production
        return res.status(403).json({ error: "Export disabled for security" });
      default:
        return await getOrCreateWallet(supabase, telegramId, res);
    }
  } catch (err) {
    console.error("Wallet API error:", err);
    return res.status(500).json({ error: err.message });
  }
};

async function getOrCreateWallet(supabase, telegramId, res) {
  // Check if wallet exists in custody_wallets
  const { data: existing, error: fetchError } = await supabase
    .from("custody_wallets")
    .select("id, user_id, polygon_address, created_at, clob_registered, usdc_approved")
    .eq("user_id", String(telegramId))
    .single();

  if (fetchError && fetchError.code !== "PGRST116") {
    // PGRST116 = no rows found
    console.error("Supabase fetch error:", fetchError);
    return res.status(500).json({ error: "Database error" });
  }

  if (existing) {
    return res.status(200).json({
      success: true,
      wallet: {
        address: existing.polygon_address,
        userId: existing.user_id,
        createdAt: existing.created_at,
        clobRegistered: existing.clob_registered || false,
        usdcApproved: existing.usdc_approved || false,
      },
      isNew: false,
    });
  }

  // Create new wallet
  const wallet = Wallet.createRandom();
  const encryptedPk = encrypt(wallet.privateKey);

  const { data: inserted, error: insertError } = await supabase
    .from("custody_wallets")
    .insert({
      user_id: String(telegramId),
      polygon_address: wallet.address.toLowerCase(),
      polygon_secret_enc: encryptedPk,
      clob_registered: false,
      usdc_approved: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return res.status(500).json({ error: "Failed to create wallet" });
  }

  // Also create user_balances entry
  await supabase.from("user_balances").upsert({
    user_id: String(telegramId),
    usdc_available: 0,
    usdc_locked: 0,
    updated_at: new Date().toISOString(),
  }).catch(e => console.error("Failed to create balance entry:", e));

  return res.status(201).json({
    success: true,
    wallet: {
      address: inserted.polygon_address,
      userId: inserted.user_id,
      createdAt: inserted.created_at,
      clobRegistered: false,
      usdcApproved: false,
    },
    isNew: true,
  });
}

async function getWalletBalance(supabase, telegramId, res) {
  const { data: wallet, error } = await supabase
    .from("custody_wallets")
    .select("polygon_address")
    .eq("user_id", String(telegramId))
    .single();

  if (error || !wallet) {
    return res.status(404).json({ error: "Wallet not found" });
  }

  // Fetch balance from Polygon
  const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
  const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

  const provider = new JsonRpcProvider(POLYGON_RPC);
  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
  const usdc = new Contract(USDC_ADDRESS, erc20Abi, provider);

  const rawBalance = await usdc.balanceOf(wallet.polygon_address);
  const usdcBalance = Number(formatUnits(rawBalance, 6));

  // Also fetch position value from Polymarket
  let positionValue = 0;
  try {
    const dataUrl = process.env.POLYMARKET_DATA_URL || "https://data-api.polymarket.com";
    const valueResp = await fetch(`${dataUrl}/value?user=${wallet.polygon_address}`);
    if (valueResp.ok) {
      const valueData = await valueResp.json();
      if (Array.isArray(valueData) && valueData[0]?.value) {
        positionValue = Number(valueData[0].value) || 0;
      }
    }
  } catch (e) {
    console.error("Position value fetch error:", e);
  }

  return res.status(200).json({
    success: true,
    address: wallet.polygon_address,
    usdcBalance,
    positionValue,
    totalValue: usdcBalance + positionValue,
  });
}

// Export helper for other APIs to use
module.exports.getWalletPrivateKey = async function (supabase, userId) {
  const { data, error } = await supabase
    .from("custody_wallets")
    .select("polygon_address, polygon_secret_enc, clob_api_key_enc, clob_api_secret_enc, clob_api_passphrase_enc")
    .eq("user_id", String(userId))
    .single();

  if (error || !data) {
    throw new Error("Wallet not found");
  }

  return {
    address: data.polygon_address,
    privateKey: decrypt(data.polygon_secret_enc),
    clobApiKey: data.clob_api_key_enc ? decrypt(data.clob_api_key_enc) : null,
    clobApiSecret: data.clob_api_secret_enc ? decrypt(data.clob_api_secret_enc) : null,
    clobApiPassphrase: data.clob_api_passphrase_enc ? decrypt(data.clob_api_passphrase_enc) : null,
  };
};

module.exports.decrypt = decrypt;
module.exports.encrypt = encrypt;

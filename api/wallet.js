// api/wallet.js
// Custodial wallet management with Supabase
// Creates both Solana and Polygon (USDC) wallets

const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { formatUnits } = require("ethers/lib/utils");
const { createClient } = require("@supabase/supabase-js");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");

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

  const action = req.query.action || req.body?.action || "get";

  try {
    if (action === "balance") {
      return await getBalance(supabase, telegramId, res);
    }
    return await getOrCreateWallet(supabase, telegramId, res);
  } catch (err) {
    console.error("Wallet API error:", err);
    return res.status(500).json({ error: err.message });
  }
};

async function getOrCreateWallet(supabase, telegramId, res) {
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
    return res.status(200).json({
      success: true,
      wallet: {
        solana: existing.solana_address,
        polygon: existing.polygon_address,
        userId: existing.user_id,
        createdAt: existing.created_at,
        clobRegistered: existing.clob_registered || false,
        usdcApproved: existing.usdc_approved || false,
      },
      isNew: false,
    });
  }

  // Create new Polygon wallet (for USDC/Polymarket)
  const polygonWallet = Wallet.createRandom();
  const encryptedPolygonPk = encrypt(polygonWallet.privateKey);

  // Create new Solana wallet
  const solanaKeypair = Keypair.generate();
  const solanaAddress = solanaKeypair.publicKey.toBase58();
  const solanaSecretKey = bs58.encode(solanaKeypair.secretKey);
  const encryptedSolanaPk = encrypt(solanaSecretKey);

  const { data: inserted, error: insertError } = await supabase
    .from("custody_wallets")
    .insert({
      user_id: String(telegramId),
      polygon_address: polygonWallet.address.toLowerCase(),
      polygon_secret_enc: encryptedPolygonPk,
      solana_address: solanaAddress,
      solana_secret_enc: encryptedSolanaPk,
      clob_registered: false,
      usdc_approved: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return res.status(500).json({ error: "Failed to create wallet", details: insertError.message });
  }

  // Also create user_balances entry
  await supabase.from("user_balances").upsert({
    user_id: String(telegramId),
    usdc_available: 0,
    usdc_locked: 0,
    sol_balance: 0,
    updated_at: new Date().toISOString(),
  }).catch(e => console.error("Balance entry error:", e));

  return res.status(201).json({
    success: true,
    wallet: {
      solana: inserted.solana_address,
      polygon: inserted.polygon_address,
      userId: inserted.user_id,
      createdAt: inserted.created_at,
      clobRegistered: false,
      usdcApproved: false,
    },
    isNew: true,
  });
}

async function getBalance(supabase, telegramId, res) {
  const { data: wallet, error } = await supabase
    .from("custody_wallets")
    .select("polygon_address")
    .eq("user_id", String(telegramId))
    .single();

  if (error || !wallet) {
    return res.status(404).json({ error: "Wallet not found" });
  }

  try {
    const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
    const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
    const usdc = new Contract(USDC_ADDRESS, erc20Abi, provider);

    const rawBalance = await usdc.balanceOf(wallet.polygon_address);
    const usdcBalance = Number(formatUnits(rawBalance, 6));

    return res.status(200).json({
      success: true,
      address: wallet.polygon_address,
      usdc: usdcBalance,
      positions: 0,
    });
  } catch (err) {
    console.error("Balance fetch error:", err);
    return res.status(200).json({
      success: true,
      address: wallet.polygon_address,
      usdc: 0,
      positions: 0,
      error: "Could not fetch on-chain balance"
    });
  }
}

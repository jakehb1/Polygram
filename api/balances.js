// api/balances.js
// Get user balances (USDC + positions)

const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { formatUnits } = require("ethers/lib/utils");
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const hasSupabase = SUPABASE_URL && SUPABASE_SERVICE_KEY;

  const telegramId = req.query.telegram_id || req.query.telegramId;
  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegram_id" });
  }

  // If Supabase not configured, return zero balances
  if (!hasSupabase) {
    return res.status(200).json({
      success: true,
      usdc: 0,
      sol: 0,
      positions: 0,
      total: 0,
      walletStatus: { exists: false }
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Get wallet
    const { data: wallet, error: walletError } = await supabase
      .from("custody_wallets")
      .select("polygon_address, clob_registered, usdc_approved")
      .eq("user_id", String(telegramId))
      .single();

    if (walletError || !wallet) {
      return res.status(200).json({
        success: true,
        usdc: 0,
        positions: 0,
        total: 0,
        walletStatus: { exists: false }
      });
    }

    // Get cached balances from user_balances table
    const { data: cachedBalance } = await supabase
      .from("user_balances")
      .select("usdc_available, usdc_locked, sol_balance")
      .eq("user_id", String(telegramId))
      .single();

    // Get on-chain USDC balance
    let usdcBalance = 0;
    try {
      const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
      const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

      const provider = new JsonRpcProvider(POLYGON_RPC);
      const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
      const usdc = new Contract(USDC_ADDRESS, erc20Abi, provider);

      const rawBalance = await usdc.balanceOf(wallet.polygon_address);
      usdcBalance = Number(formatUnits(rawBalance, 6));
      
      // Update cached balance if on-chain balance is different
      if (cachedBalance && cachedBalance.usdc_available !== usdcBalance) {
        await supabase
          .from("user_balances")
          .upsert({
            user_id: String(telegramId),
            usdc_available: usdcBalance,
            usdc_locked: cachedBalance.usdc_locked || 0,
            sol_balance: cachedBalance.sol_balance || 0,
          }, {
            onConflict: 'user_id'
          });
      }
    } catch (e) {
      console.error("On-chain balance error:", e);
      // Fallback to cached balance if on-chain check fails
      if (cachedBalance) {
        usdcBalance = Number(cachedBalance.usdc_available || 0);
      }
    }

    // Get SOL balance (from cache for now, can add on-chain check later)
    const solBalance = cachedBalance ? Number(cachedBalance.sol_balance || 0) : 0;

    // Get positions value from DB
    const { data: positions } = await supabase
      .from("positions")
      .select("current_value")
      .eq("user_id", String(telegramId));

    const positionsValue = (positions || []).reduce((sum, p) => sum + (p.current_value || 0), 0);

    return res.status(200).json({
      success: true,
      usdc: usdcBalance,
      sol: solBalance,
      positions: positionsValue,
      total: usdcBalance + positionsValue,
      walletStatus: {
        exists: true,
        address: wallet.polygon_address,
        clobRegistered: wallet.clob_registered || false,
        usdcApproved: wallet.usdc_approved || false,
      }
    });
  } catch (err) {
    console.error("Balances error:", err);
    return res.status(500).json({ error: err.message });
  }
};

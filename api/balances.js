// api/balances.js
// Get wallet balances - supports both direct address and telegram_id lookup

const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { formatUnits } = require("ethers/lib/utils");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const DATA_URL = process.env.POLYMARKET_DATA_URL || "https://data-api.polymarket.com";

// USDC.e on Polygon
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  // Support both direct address and telegram_id lookup
  let address = req.query.address;
  const telegramId = req.query.telegram_id || req.query.telegramId;

  // If telegram_id provided, look up address from Supabase
  if (!address && telegramId) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Database not configured for telegram lookup" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from("custody_wallets")
      .select("polygon_address, clob_registered, usdc_approved")
      .eq("user_id", String(telegramId))
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Wallet not found for this user" });
    }

    address = data.polygon_address;

    // Include wallet status in response
    var walletStatus = {
      clobRegistered: data.clob_registered || false,
      usdcApproved: data.usdc_approved || false,
    };
  }

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "invalid_address" });
  }

  try {
    // Create provider and contract
    const provider = new JsonRpcProvider(POLYGON_RPC);
    const usdc = new Contract(USDC_ADDRESS, erc20Abi, provider);

    // Fetch USDC balance and position value in parallel
    const [rawBalance, valueResp, maticBalance] = await Promise.all([
      usdc.balanceOf(address),
      fetch(`${DATA_URL}/value?user=${address}`).catch(() => null),
      provider.getBalance(address), // MATIC for gas
    ]);

    const usdcBalance = Number(formatUnits(rawBalance, 6));
    const maticForGas = Number(formatUnits(maticBalance, 18));

    let openPositionsValue = 0;
    if (valueResp && valueResp.ok) {
      try {
        const json = await valueResp.json();
        if (Array.isArray(json) && json[0]?.value != null) {
          openPositionsValue = Number(json[0].value) || 0;
        }
      } catch (e) {}
    }

    const response = {
      address,
      usdcAvailable: usdcBalance,
      openPositionsValue,
      pendingOrdersValue: 0, // TODO: Fetch from CLOB
      totalValue: usdcBalance + openPositionsValue,
      maticForGas,
      hasGas: maticForGas >= 0.01, // Need some MATIC for approvals
    };

    // Include wallet status if looked up via telegram_id
    if (walletStatus) {
      response.walletStatus = walletStatus;
      response.readyToTrade = walletStatus.clobRegistered && walletStatus.usdcApproved && response.hasGas;
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("balances error", err);
    return res.status(500).json({ error: "failed_to_fetch" });
  }
};

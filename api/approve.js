// api/approve.js
// Approve USDC spending for Polymarket CLOB trading
// This is a one-time setup per wallet

const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { formatUnits, parseUnits } = require("ethers/lib/utils");
const { MaxUint256 } = require("@ethersproject/constants");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";

// Polygon addresses
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; // USDC.e
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Polymarket CTF Exchange
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"; // Neg Risk Exchange

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

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Database not configured" });
  }

  const tgId = req.query.telegram_id || req.body?.telegram_id || 
               req.query.telegramId || req.body?.telegramId;

  if (!tgId) {
    return res.status(400).json({ error: "Missing telegram_id" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Fetch wallet
    const { data: walletData, error: fetchError } = await supabase
      .from("custody_wallets")
      .select("*")
      .eq("user_id", String(tgId))
      .single();

    if (fetchError || !walletData) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);

    // GET = check allowance status
    if (req.method === "GET") {
      const [allowanceCTF, allowanceNegRisk] = await Promise.all([
        usdc.allowance(walletData.polygon_address, CTF_EXCHANGE),
        usdc.allowance(walletData.polygon_address, NEG_RISK_CTF_EXCHANGE),
      ]);

      const maxUint = MaxUint256;
      const threshold = parseUnits("1000000", 6); // 1M USDC

      return res.status(200).json({
        success: true,
        address: walletData.polygon_address,
        approvals: {
          ctfExchange: {
            address: CTF_EXCHANGE,
            allowance: formatUnits(allowanceCTF, 6),
            approved: allowanceCTF.gte(threshold),
          },
          negRiskExchange: {
            address: NEG_RISK_CTF_EXCHANGE,
            allowance: formatUnits(allowanceNegRisk, 6),
            approved: allowanceNegRisk.gte(threshold),
          },
        },
        fullyApproved: allowanceCTF.gte(threshold) && allowanceNegRisk.gte(threshold),
      });
    }

    // POST = execute approval transactions
    if (req.method === "POST") {
      const privateKey = decrypt(walletData.polygon_secret_enc);
      const wallet = new Wallet(privateKey, provider);
      const usdcWithSigner = usdc.connect(wallet);

      const maxApproval = MaxUint256;
      const results = [];

      // Check if already approved
      const [allowanceCTF, allowanceNegRisk] = await Promise.all([
        usdc.allowance(walletData.polygon_address, CTF_EXCHANGE),
        usdc.allowance(walletData.polygon_address, NEG_RISK_CTF_EXCHANGE),
      ]);

      const threshold = parseUnits("1000000", 6);

      // Approve CTF Exchange if needed
      if (allowanceCTF.lt(threshold)) {
        try {
          const tx1 = await usdcWithSigner.approve(CTF_EXCHANGE, maxApproval);
          await tx1.wait();
          results.push({ exchange: "CTF", txHash: tx1.hash, success: true });
        } catch (e) {
          results.push({ exchange: "CTF", error: e.message, success: false });
        }
      } else {
        results.push({ exchange: "CTF", success: true, alreadyApproved: true });
      }

      // Approve Neg Risk Exchange if needed
      if (allowanceNegRisk.lt(threshold)) {
        try {
          const tx2 = await usdcWithSigner.approve(NEG_RISK_CTF_EXCHANGE, maxApproval);
          await tx2.wait();
          results.push({ exchange: "NegRisk", txHash: tx2.hash, success: true });
        } catch (e) {
          results.push({ exchange: "NegRisk", error: e.message, success: false });
        }
      } else {
        results.push({ exchange: "NegRisk", success: true, alreadyApproved: true });
      }

      // Update wallet status in Supabase
      const allSuccess = results.every(r => r.success);
      if (allSuccess) {
        await supabase
          .from("custody_wallets")
          .update({ usdc_approved: true, updated_at: new Date().toISOString() })
          .eq("user_id", String(tgId));
      }

      return res.status(200).json({
        success: allSuccess,
        results,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("Approve error:", err);
    return res.status(500).json({ error: err.message });
  }
};

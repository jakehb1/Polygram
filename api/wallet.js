// api/wallet.js
// Simple wallet generation - works without database for MVP

const { Wallet } = require("@ethersproject/wallet");

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

  const telegramId = req.query.telegram_id || req.query.telegramId || `demo_${Date.now()}`;

  try {
    // Generate new wallets
    const polygonWallet = Wallet.createRandom();
    const solanaAddress = generateSolanaAddress();

    console.log("[wallet] Generated wallets for user:", telegramId);

    return res.status(200).json({
      success: true,
      wallet: {
        solana: solanaAddress,
        polygon: polygonWallet.address.toLowerCase(),
        userId: telegramId,
        createdAt: new Date().toISOString(),
      },
      isNew: true,
    });

  } catch (err) {
    console.error("[wallet] Error:", err);
    return res.status(500).json({ 
      error: "Failed to generate wallet", 
      details: err.message 
    });
  }
};

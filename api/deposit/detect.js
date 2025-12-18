// api/deposit/detect.js
// Epic 3.1: TON Deposit Detection Endpoint
// This endpoint can be called by an indexer/webhook when a TON deposit is detected
// Or can be polled to check for new deposits

const { createClient } = require("@supabase/supabase-js");
const { handleApiError, validateTONAddress, ERROR_CODES } = require("../lib/errors");
const { logError, logTransaction, logSecurityEvent } = require("../lib/logger");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "method_not_allowed",
      message: `Method ${req.method} not allowed`
    });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: "database_not_configured",
      message: "Supabase not configured"
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const {
      ton_tx_hash,
      ton_address,
      amount_ton,
      confirmations,
      block_number,
      timestamp
    } = req.body;

    if (!ton_tx_hash || !ton_address || !amount_ton) {
      return res.status(400).json({
        error: ERROR_CODES.MISSING_REQUIRED_FIELDS,
        message: "ton_tx_hash, ton_address, and amount_ton are required"
      });
    }

    // Validate TON address
    try {
      validateTONAddress(ton_address);
    } catch (validationError) {
      return res.status(400).json({
        error: ERROR_CODES.INVALID_ADDRESS,
        message: validationError.message
      });
    }

    // Find user by TON address
    const { data: wallet, error: walletError } = await supabase
      .from("custody_wallets")
      .select("user_id, ton_address")
      .eq("ton_address", ton_address)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({
        error: "user_not_found",
        message: "No user found with this TON address"
      });
    }

    // Check if deposit already exists
    const { data: existing, error: checkError } = await supabase
      .from("ton_deposits")
      .select("id, status")
      .eq("ton_tx_hash", ton_tx_hash)
      .single();

    if (existing) {
      // Update confirmations if needed
      if (confirmations > existing.confirmations) {
        await supabase
          .from("ton_deposits")
          .update({
            confirmations: confirmations,
            status: confirmations >= 1 ? 'confirmed' : existing.status
          })
          .eq("id", existing.id);
      }
      return res.status(200).json({
        success: true,
        deposit_id: existing.id,
        status: existing.status,
        message: "Deposit already recorded"
      });
    }

    // Create deposit record
    const depositData = {
      user_id: wallet.user_id,
      ton_address: ton_address,
      ton_tx_hash: ton_tx_hash,
      amount_ton: parseFloat(amount_ton),
      status: confirmations >= 1 ? 'confirmed' : 'pending',
      confirmations: confirmations || 0,
      required_confirmations: 1
    };

    const { data: deposit, error: insertError } = await supabase
      .from("ton_deposits")
      .insert(depositData)
      .select()
      .single();

    if (insertError) {
      throw insertError;
    }

    // If confirmed, trigger bridge process
    if (deposit.status === 'confirmed') {
      // Update status to bridging
      await supabase
        .from("ton_deposits")
        .update({ 
          status: 'bridging',
          confirmed_at: new Date().toISOString()
        })
        .eq("id", deposit.id);

      // TODO: Call bridge service to convert TON -> Polygon USDC
      // For now, we'll simulate the bridge completion
      // In production, this would call an actual bridge service
      
      // Simulate bridge completion after a delay
      setTimeout(async () => {
        try {
          // Calculate USDC amount (mock conversion rate: 1 TON = ~$2.50 USDC)
          const conversionRate = 2.5; // TODO: Get real conversion rate
          const amountUSDC = deposit.amount_ton * conversionRate;
          
          // Epic 6.2: Create ledger entry for deposit
          const { createLedgerEntry, updateLedgerEntryStatus } = require("../lib/ledger");
          let ledgerEntryId;
          try {
            ledgerEntryId = await createLedgerEntry({
              user_id: wallet.user_id,
              entry_type: 'deposit',
              amount: amountUSDC,
              currency: 'USDC',
              direction: 'credit',
              status: 'bridging',
              metadata: {
                ton_amount: deposit.amount_ton,
                conversion_rate: conversionRate,
                ton_tx_hash: deposit.ton_tx_hash
              },
              deposit_id: deposit.id,
              source_tx_hash: deposit.ton_tx_hash
            });

            // Log transaction
            logTransaction('deposit_detected', {
              user_id: wallet.user_id,
              deposit_id: deposit.id,
              ton_tx_hash: deposit.ton_tx_hash,
              amount_ton: deposit.amount_ton,
              amount_usdc: amountUSDC,
              conversion_rate: conversionRate,
              ledger_entry_id: ledgerEntryId
            });
          } catch (ledgerError) {
            logError(ledgerError, {
              operation: 'ledger_entry_creation',
              user_id: wallet.user_id,
              deposit_id: deposit.id
            });
            // Continue even if ledger fails
          }
          
          // Update user balance
          const { error: balanceError } = await supabase.rpc('increment_balance', {
            p_user_id: wallet.user_id,
            p_amount: amountUSDC
          });

          // If RPC doesn't exist, use update
          if (balanceError) {
            const { data: currentBalance } = await supabase
              .from("user_balances")
              .select("usdc_available")
              .eq("user_id", wallet.user_id)
              .single();

            await supabase
              .from("user_balances")
              .update({
                usdc_available: (currentBalance?.usdc_available || 0) + amountUSDC
              })
              .eq("user_id", wallet.user_id);
          }

          // Update deposit status
          await supabase
            .from("ton_deposits")
            .update({
              status: 'completed',
              amount_usdc: amountUSDC,
              completed_at: new Date().toISOString()
            })
            .eq("id", deposit.id);

          // Epic 6.2: Update ledger entry to completed
          if (ledgerEntryId) {
            try {
              await updateLedgerEntryStatus(ledgerEntryId, 'completed', null, null);
            } catch (ledgerError) {
              console.error("[deposit/detect] Ledger update failed:", ledgerError);
            }
          }

        } catch (bridgeError) {
          logError(bridgeError, {
            operation: 'bridge_simulation',
            deposit_id: deposit.id,
            user_id: wallet.user_id,
            ton_tx_hash: deposit.ton_tx_hash
          });
          
          await supabase
            .from("ton_deposits")
            .update({
              status: 'failed',
              error_message: bridgeError.message
            })
            .eq("id", deposit.id);
        }
      }, 5000); // Simulate 5 second bridge delay
    }

    return res.status(200).json({
      success: true,
      deposit_id: deposit.id,
      status: deposit.status,
      message: "Deposit detected and recorded"
    });

  } catch (err) {
    return handleApiError(err, req, res, {
      operation: 'deposit_detection',
      endpoint: '/api/deposit/detect'
    });
  }
};

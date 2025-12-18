// api/withdraw/request.js
// Epic 5.1 & 5.2: Withdrawal Request with Security Controls
// Handles withdrawal requests with security checks

const { createClient } = require("@supabase/supabase-js");
const { validateSession } = require("../middleware/validate-session");
const { checkIdempotency, storeIdempotencyKey, checkRateLimit, hashRequest } = require("../lib/security");
const { handleApiError, validateAmount, validateTONAddress, ERROR_CODES } = require("../lib/errors");
const { logError, logTransaction, logSecurityEvent } = require("../lib/logger");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

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
    if (req.method === "POST") {
      // Create withdrawal request
      // Phase 2: Require valid session
      const authHeader = req.headers.authorization;
      const sessionToken = authHeader?.startsWith('Bearer ') 
        ? authHeader.substring(7)
        : req.body?.session_token;

      if (!sessionToken) {
        return res.status(401).json({
          error: "authentication_required",
          message: "Session token required"
        });
      }

      const sessionValidation = await validateSession(sessionToken);
      if (!sessionValidation.isValid) {
        return res.status(401).json({
          error: "invalid_session",
          message: sessionValidation.error || "Invalid or expired session"
        });
      }

      const userId = sessionValidation.userId;

      const {
        amount_usdc,
        ton_destination_address,
        idempotency_key,
        address_signature,
        address_public_key
      } = req.body;

      // Validate amount
      try {
        validateAmount(amount_usdc, 1); // Minimum $1
      } catch (validationError) {
        return res.status(400).json({
          error: ERROR_CODES.INVALID_AMOUNT,
          message: validationError.message
        });
      }

      // Validate TON address
      try {
        validateTONAddress(ton_destination_address);
      } catch (validationError) {
        return res.status(400).json({
          error: ERROR_CODES.INVALID_ADDRESS,
          message: validationError.message
        });
      }

      // Rate limiting (5 withdrawals per hour per user)
      const rateLimit = await checkRateLimit(userId, "withdrawal", 5, 60);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          error: "rate_limit_exceeded",
          message: rateLimit.error || "Too many withdrawal requests",
          resetAt: rateLimit.resetAt?.toISOString()
        });
      }

      // Idempotency check
      const requestHash = hashRequest({ userId, amount_usdc, ton_destination_address });
      if (idempotency_key) {
        const idempotencyCheck = await checkIdempotency(
          idempotency_key,
          userId,
          "withdrawal",
          requestHash,
          120 // 2 hour TTL for withdrawals
        );

        if (idempotencyCheck.error) {
          return res.status(400).json({
            error: "idempotency_key_conflict",
            message: idempotencyCheck.error
          });
        }

        if (idempotencyCheck.exists && idempotencyCheck.cachedResponse) {
          return res.status(200).json(idempotencyCheck.cachedResponse);
        }
      }

      // Check balance
      const { data: balance, error: balanceError } = await supabase
        .from("user_balances")
        .select("usdc_available")
        .eq("user_id", userId)
        .single();

      if (balanceError || !balance) {
        return res.status(500).json({
          error: "balance_check_failed",
          message: "Failed to check balance"
        });
      }

      if (balance.usdc_available < amount_usdc) {
        return res.status(400).json({
          error: "insufficient_balance",
          message: `Insufficient balance. Available: $${balance.usdc_available.toFixed(2)}, Requested: $${amount_usdc.toFixed(2)}`
        });
      }

      // Epic 5.2: Verify destination address confirmation (if signature provided)
      if (address_signature && address_public_key) {
        // TODO: Verify TON signature that user owns the destination address
        // For now, we'll store the confirmation
        const { error: confirmError } = await supabase
          .from("withdrawal_address_confirmations")
          .insert({
            user_id: userId,
            ton_address: ton_destination_address,
            signature: address_signature,
            public_key: address_public_key,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
          });

        if (confirmError && confirmError.code !== '23505') {
          console.warn("[withdraw/request] Address confirmation error:", confirmError);
        }
      } else {
        // Check if address is already confirmed for this user
        const { data: confirmedAddress } = await supabase
          .from("withdrawal_address_confirmations")
          .select("id")
          .eq("user_id", userId)
          .eq("ton_address", ton_destination_address)
          .eq("is_active", true)
          .gt("expires_at", new Date().toISOString())
          .single();

        if (!confirmedAddress) {
          return res.status(400).json({
            error: "address_not_confirmed",
            message: "Destination address must be confirmed with signature. Please sign the address confirmation."
          });
        }
      }

      // Epic 5.2: Risk checks
      const LARGE_WITHDRAWAL_THRESHOLD = 1000; // $1000 USDC
      const riskCheckPassed = amount_usdc < LARGE_WITHDRAWAL_THRESHOLD; // Simplified
      const riskCheckDetails = {
        amount_check: amount_usdc < LARGE_WITHDRAWAL_THRESHOLD,
        address_confirmed: true,
        timestamp: new Date().toISOString()
      };

      // Generate unique request ID
      const requestId = `withdraw_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      // Create withdrawal record
      const { data: withdrawal, error: insertError } = await supabase
        .from("withdrawals")
        .insert({
          user_id: userId,
          request_id: requestId,
          amount_usdc: parseFloat(amount_usdc),
          ton_destination_address: ton_destination_address,
          status: riskCheckPassed ? 'pending' : 'pending_review',
          risk_check_passed: riskCheckPassed,
          risk_check_details: riskCheckDetails
        })
        .select()
        .single();

      if (insertError) {
        throw insertError;
      }

      // Lock funds (decrease available balance)
      await supabase
        .from("user_balances")
        .update({
          usdc_available: balance.usdc_available - amount_usdc
        })
        .eq("user_id", userId);

      // Epic 6.2: Create ledger entry for withdrawal
      const { createLedgerEntry } = require("../lib/ledger");
      let ledgerEntryId;
      try {
        ledgerEntryId = await createLedgerEntry({
          user_id: userId,
          entry_type: 'withdrawal',
          amount: amount_usdc,
          currency: 'USDC',
          direction: 'debit',
          status: withdrawal.status,
          metadata: {
            ton_destination: ton_destination_address,
            risk_check_passed: riskCheckPassed
          },
          withdrawal_id: withdrawal.id
        });

        // Log transaction
        logTransaction('withdrawal_requested', {
          user_id: userId,
          withdrawal_id: withdrawal.id,
          request_id: withdrawal.request_id,
          amount_usdc: amount_usdc,
          ton_destination: ton_destination_address,
          risk_check_passed: riskCheckPassed,
          ledger_entry_id: ledgerEntryId
        });
      } catch (ledgerError) {
        logError(ledgerError, {
          operation: 'ledger_entry_creation',
          user_id: userId,
          withdrawal_id: withdrawal.id
        });
        // Continue even if ledger fails
      }

      // TODO: Process withdrawal (bridge Polygon USDC -> TON)
      // For now, we'll mark it as processing
      // In production, this would trigger the bridge service

      const response = {
        success: true,
        withdrawal: withdrawal,
        message: riskCheckPassed 
          ? "Withdrawal request created" 
          : "Withdrawal request created and pending review"
      };

      // Store idempotency key
      if (idempotency_key) {
        await storeIdempotencyKey(idempotency_key, userId, "withdrawal", requestHash, response, 120);
      }

      return res.status(200).json(response);

    } else if (req.method === "GET") {
      // Get withdrawal status
      const authHeader = req.headers.authorization;
      const sessionToken = authHeader?.startsWith('Bearer ') 
        ? authHeader.substring(7)
        : req.query?.session_token;

      if (!sessionToken) {
        return res.status(401).json({
          error: "authentication_required",
          message: "Session token required"
        });
      }

      const sessionValidation = await validateSession(sessionToken);
      if (!sessionValidation.isValid) {
        return res.status(401).json({
          error: "invalid_session",
          message: sessionValidation.error || "Invalid or expired session"
        });
      }

      const userId = sessionValidation.userId;
      const requestId = req.query?.request_id;

      if (requestId) {
        // Get specific withdrawal
        const { data: withdrawal, error } = await supabase
          .from("withdrawals")
          .select("*")
          .eq("user_id", userId)
          .eq("request_id", requestId)
          .single();

        if (error || !withdrawal) {
          return res.status(404).json({
            error: "withdrawal_not_found",
            message: "Withdrawal not found"
          });
        }

        return res.status(200).json({
          success: true,
          withdrawal: withdrawal
        });
      } else {
        // List withdrawals for user
        const { data: withdrawals, error } = await supabase
          .from("withdrawals")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) {
          throw error;
        }

        return res.status(200).json({
          success: true,
          withdrawals: withdrawals || [],
          count: withdrawals?.length || 0
        });
      }
    } else {
      return res.status(405).json({
        error: "method_not_allowed",
        message: `Method ${req.method} not allowed`
      });
    }

  } catch (err) {
    return handleApiError(err, req, res, {
      operation: 'withdrawal',
      amount_usdc: req.body?.amount_usdc
    });
  }
};

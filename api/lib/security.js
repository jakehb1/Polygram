// api/lib/security.js
// Security helper functions: nonce validation, idempotency, rate limiting

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

/**
 * Validate and record a nonce to prevent replay attacks
 * @param {string} userId - User ID
 * @param {string} nonce - Nonce value
 * @param {number} ttlMinutes - Time to live in minutes (default: 10)
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function validateNonce(userId, nonce, ttlMinutes = 10) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    // If Supabase not configured, skip validation (for development)
    return { valid: true };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Check if nonce already exists and is used
    const { data: existingNonce, error: fetchError } = await supabase
      .from("nonces")
      .select("used, expires_at")
      .eq("user_id", userId)
      .eq("nonce", nonce)
      .single();

    if (existingNonce) {
      if (existingNonce.used) {
        return { valid: false, error: "Nonce already used" };
      }
      if (new Date(existingNonce.expires_at) < new Date()) {
        return { valid: false, error: "Nonce expired" };
      }
      // Mark as used
      await supabase
        .from("nonces")
        .update({ used: true })
        .eq("user_id", userId)
        .eq("nonce", nonce);
      return { valid: true };
    }

    // Create new nonce
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const { error: insertError } = await supabase
      .from("nonces")
      .insert({
        user_id: userId,
        nonce: nonce,
        used: false,
        expires_at: expiresAt.toISOString()
      });

    if (insertError) {
      // If duplicate, nonce was already used
      if (insertError.code === '23505') {
        return { valid: false, error: "Nonce already exists" };
      }
      throw insertError;
    }

    return { valid: true };

  } catch (err) {
    console.error("[security] Nonce validation error:", err);
    return { valid: false, error: "Nonce validation failed" };
  }
}

/**
 * Check idempotency key and return cached response if exists
 * @param {string} idempotencyKey - Idempotency key
 * @param {string} userId - User ID
 * @param {string} operation - Operation type (e.g., 'trade', 'withdrawal')
 * @param {string} requestHash - Hash of request body
 * @param {number} ttlMinutes - Time to live in minutes (default: 60)
 * @returns {Promise<{exists: boolean, cachedResponse?: any, error?: string}>}
 */
async function checkIdempotency(idempotencyKey, userId, operation, requestHash, ttlMinutes = 60) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { exists: false };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const { data: existing, error } = await supabase
      .from("idempotency_keys")
      .select("response_body, request_hash, expires_at")
      .eq("idempotency_key", idempotencyKey)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (existing) {
      // Check if expired
      if (new Date(existing.expires_at) < new Date()) {
        // Clean up expired key
        await supabase
          .from("idempotency_keys")
          .delete()
          .eq("idempotency_key", idempotencyKey);
        return { exists: false };
      }

      // Verify request hash matches (prevent different requests with same key)
      if (existing.request_hash && existing.request_hash !== requestHash) {
        return { exists: true, error: "Idempotency key used with different request" };
      }

      // Return cached response
      return { exists: true, cachedResponse: existing.response_body };
    }

    return { exists: false };

  } catch (err) {
    console.error("[security] Idempotency check error:", err);
    return { exists: false, error: "Idempotency check failed" };
  }
}

/**
 * Store idempotency key with response
 * @param {string} idempotencyKey - Idempotency key
 * @param {string} userId - User ID
 * @param {string} operation - Operation type
 * @param {string} requestHash - Hash of request body
 * @param {any} responseBody - Response to cache
 * @param {number} ttlMinutes - Time to live in minutes (default: 60)
 */
async function storeIdempotencyKey(idempotencyKey, userId, operation, requestHash, responseBody, ttlMinutes = 60) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    
    await supabase
      .from("idempotency_keys")
      .insert({
        idempotency_key: idempotencyKey,
        user_id: userId,
        operation: operation,
        request_hash: requestHash,
        response_body: responseBody,
        expires_at: expiresAt.toISOString()
      });

  } catch (err) {
    // Ignore duplicate key errors (race condition)
    if (err.code !== '23505') {
      console.error("[security] Store idempotency key error:", err);
    }
  }
}

/**
 * Check rate limit for user and endpoint
 * @param {string} userId - User ID
 * @param {string} endpoint - Endpoint name
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowMinutes - Time window in minutes (default: 1)
 * @returns {Promise<{allowed: boolean, remaining?: number, resetAt?: Date, error?: string}>}
 */
async function checkRateLimit(userId, endpoint, maxRequests, windowMinutes = 1) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { allowed: true }; // Skip rate limiting if DB not configured
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const windowStart = new Date();
    windowStart.setMinutes(windowStart.getMinutes() - windowStart.getMinutes() % windowMinutes);
    windowStart.setSeconds(0);
    windowStart.setMilliseconds(0);

    // Get or create rate limit record
    const { data: rateLimit, error: fetchError } = await supabase
      .from("rate_limits")
      .select("request_count, window_start")
      .eq("user_id", userId)
      .eq("endpoint", endpoint)
      .eq("window_start", windowStart.toISOString())
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    if (rateLimit) {
      if (rateLimit.request_count >= maxRequests) {
        const resetAt = new Date(rateLimit.window_start);
        resetAt.setMinutes(resetAt.getMinutes() + windowMinutes);
        return {
          allowed: false,
          remaining: 0,
          resetAt: resetAt,
          error: `Rate limit exceeded. Try again after ${resetAt.toISOString()}`
        };
      }

      // Increment count
      await supabase
        .from("rate_limits")
        .update({ request_count: rateLimit.request_count + 1 })
        .eq("user_id", userId)
        .eq("endpoint", endpoint)
        .eq("window_start", windowStart.toISOString());

      return {
        allowed: true,
        remaining: maxRequests - rateLimit.request_count - 1,
        resetAt: new Date(windowStart.getTime() + windowMinutes * 60 * 1000)
      };
    } else {
      // Create new record
      await supabase
        .from("rate_limits")
        .insert({
          user_id: userId,
          endpoint: endpoint,
          request_count: 1,
          window_start: windowStart.toISOString()
        });

      return {
        allowed: true,
        remaining: maxRequests - 1,
        resetAt: new Date(windowStart.getTime() + windowMinutes * 60 * 1000)
      };
    }

  } catch (err) {
    console.error("[security] Rate limit check error:", err);
    // On error, allow request (fail open for availability)
    return { allowed: true, error: "Rate limit check failed" };
  }
}

/**
 * Generate a hash of request body for idempotency
 */
function hashRequest(body) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
}

module.exports = {
  validateNonce,
  checkIdempotency,
  storeIdempotencyKey,
  checkRateLimit,
  hashRequest
};

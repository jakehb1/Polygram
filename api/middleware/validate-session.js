// api/middleware/validate-session.js
// Phase 2: Session validation middleware for protected endpoints

const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const { logSecurityEvent } = require("../lib/logger");
const crypto = require("crypto");

/**
 * Validate JWT session token and return user info
 * Returns { isValid: boolean, userId: string, tonAddress: string, error: string }
 */
async function validateSession(sessionToken) {
  try {
    if (!sessionToken) {
      return { isValid: false, error: "No session token provided" };
    }

    // Get JWT secret from environment
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("[validate-session] JWT_SECRET not configured");
      return { isValid: false, error: "Server configuration error" };
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(sessionToken, jwtSecret, {
        issuer: 'polygram',
        audience: 'polygram_app'
      });
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return { isValid: false, error: "Session expired" };
      } else if (jwtError.name === 'JsonWebTokenError') {
        return { isValid: false, error: "Invalid session token" };
      }
      throw jwtError;
    }

    // Verify session exists in database and is not revoked
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      // If Supabase not configured, still validate JWT (for development)
      return {
        isValid: true,
        userId: decoded.user_id,
        tonAddress: decoded.ton_address
      };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    
    const { data: session, error } = await supabase
      .from("sessions")
      .select("user_id, ton_address, expires_at, is_revoked")
      .eq("session_token", sessionToken)
      .single();

    if (error || !session) {
      return { isValid: false, error: "Session not found" };
    }

    if (session.is_revoked) {
      return { isValid: false, error: "Session revoked" };
    }

    // Check if session expired in database
    const expiresAt = new Date(session.expires_at);
    if (expiresAt < new Date()) {
      return { isValid: false, error: "Session expired" };
    }

    // Update last_used_at
    await supabase
      .from("sessions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("session_token", sessionToken);

    return {
      isValid: true,
      userId: session.user_id,
      tonAddress: session.ton_address
    };

  } catch (err) {
    console.error("[validate-session] Error:", err);
    return { isValid: false, error: "Session validation failed" };
  }
}

/**
 * Express-style middleware function for session validation
 * Use in API endpoints that require authentication
 */
function requireSession(req, res, next) {
  // Get token from Authorization header or request body
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith('Bearer ') 
    ? authHeader.substring(7)
    : req.body?.session_token || req.query?.session_token;

  if (!sessionToken) {
    return res.status(401).json({
      error: "authentication_required",
      message: "Session token required"
    });
  }

  // Validate session
  validateSession(sessionToken).then(result => {
    if (!result.isValid) {
      return res.status(401).json({
        error: "invalid_session",
        message: result.error || "Invalid or expired session"
      });
    }

    // Attach user info to request object
    req.user = {
      userId: result.userId,
      tonAddress: result.tonAddress,
      sessionToken: sessionToken
    };

    next();
  }).catch(err => {
    console.error("[requireSession] Error:", err);
    return res.status(500).json({
      error: "session_validation_error",
      message: "Failed to validate session"
    });
  });
}

module.exports = {
  validateSession,
  requireSession
};

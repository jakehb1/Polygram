// api/lib/errors.js
// Epic 7.1: Centralized Error Handling and Logging
// Provides consistent error responses and logging

/**
 * Standard error response format
 */
function createErrorResponse(errorCode, message, details = null) {
  return {
    error: errorCode,
    message: message,
    details: details,
    timestamp: new Date().toISOString()
  };
}

/**
 * Common error codes and messages
 */
const ERROR_CODES = {
  // Authentication
  AUTHENTICATION_REQUIRED: 'authentication_required',
  INVALID_SESSION: 'invalid_session',
  SESSION_EXPIRED: 'session_expired',
  
  // Validation
  MISSING_REQUIRED_FIELDS: 'missing_required_fields',
  INVALID_INPUT: 'invalid_input',
  INVALID_AMOUNT: 'invalid_amount',
  INVALID_ADDRESS: 'invalid_address',
  
  // Resources
  WALLET_NOT_FOUND: 'wallet_not_found',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  DEPOSIT_NOT_FOUND: 'deposit_not_found',
  WITHDRAWAL_NOT_FOUND: 'withdrawal_not_found',
  
  // Security
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  INVALID_NONCE: 'invalid_nonce',
  IDEMPOTENCY_KEY_CONFLICT: 'idempotency_key_conflict',
  ADDRESS_NOT_CONFIRMED: 'address_not_confirmed',
  
  // System
  DATABASE_NOT_CONFIGURED: 'database_not_configured',
  INTERNAL_ERROR: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  
  // Bridge/Network
  BRIDGE_FAILED: 'bridge_failed',
  TRANSACTION_FAILED: 'transaction_failed',
  NETWORK_ERROR: 'network_error'
};

/**
 * Log error with context (uses logger module)
 */
function logError(error, context = {}) {
  const { logError: loggerError } = require('./logger');
  return loggerError(error?.message || 'Unknown error', error, context);
}

/**
 * Handle API errors consistently
 */
function handleApiError(err, req, res, context = {}) {
  logError(err, {
    ...context,
    method: req.method,
    url: req.url,
    userId: req.user?.userId || req.body?.telegram_id || req.query?.telegram_id
  });

  // Determine error code and message
  let errorCode = ERROR_CODES.INTERNAL_ERROR;
  let message = 'An unexpected error occurred';
  let statusCode = 500;

  // Map known errors
  if (err.code === 'PGRST116' || err.message?.includes('not found')) {
    errorCode = ERROR_CODES.WALLET_NOT_FOUND;
    message = 'Resource not found';
    statusCode = 404;
  } else if (err.message?.includes('insufficient') || err.message?.includes('balance')) {
    errorCode = ERROR_CODES.INSUFFICIENT_BALANCE;
    message = err.message || 'Insufficient balance';
    statusCode = 400;
  } else if (err.message?.includes('rate limit') || err.message?.includes('too many')) {
    errorCode = ERROR_CODES.RATE_LIMIT_EXCEEDED;
    message = err.message || 'Rate limit exceeded';
    statusCode = 429;
  } else if (err.message?.includes('session') || err.message?.includes('token')) {
    errorCode = ERROR_CODES.INVALID_SESSION;
    message = err.message || 'Invalid or expired session';
    statusCode = 401;
  } else if (err.message?.includes('database') || err.message?.includes('Supabase')) {
    errorCode = ERROR_CODES.DATABASE_NOT_CONFIGURED;
    message = 'Database configuration error';
    statusCode = 500;
  } else if (err.message) {
    message = err.message;
  }

  return res.status(statusCode).json(createErrorResponse(errorCode, message));
}

/**
 * Validate and sanitize user input
 */
function validateAmount(amount, min = 0, max = null) {
  const num = parseFloat(amount);
  
  if (isNaN(num) || num <= 0) {
    throw new Error('Amount must be a positive number');
  }
  
  if (num < min) {
    throw new Error(`Minimum amount is ${min}`);
  }
  
  if (max !== null && num > max) {
    throw new Error(`Maximum amount is ${max}`);
  }
  
  return num;
}

/**
 * Validate TON address format
 */
function validateTONAddress(address) {
  if (!address || typeof address !== 'string') {
    throw new Error('TON address is required');
  }
  
  // Basic TON address validation (workchain:hex format or base64)
  if (!address.match(/^[0-9A-Za-z_-]{48}$/) && !address.includes(':')) {
    throw new Error('Invalid TON address format');
  }
  
  return address.trim();
}

/**
 * Validate Ethereum/Polygon address format
 */
function validateEVMAddress(address) {
  if (!address || typeof address !== 'string') {
    throw new Error('Ethereum address is required');
  }
  
  // Ethereum address validation (0x followed by 40 hex characters)
  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    throw new Error('Invalid Ethereum address format');
  }
  
  return address.toLowerCase();
}

module.exports = {
  createErrorResponse,
  ERROR_CODES,
  logError,
  handleApiError,
  validateAmount,
  validateTONAddress,
  validateEVMAddress
};

// api/lib/logger.js
// Epic 7.1: Centralized Logging System
// Provides structured logging for errors, transactions, and security events

/**
 * Log levels
 */
const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug'
};

/**
 * Log error with context
 * @param {string} message - Error message
 * @param {Error} error - Error object
 * @param {Object} context - Additional context
 */
function logError(message, error = null, context = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: LOG_LEVELS.ERROR,
    message: message,
    error: error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    } : null,
    context: context
  };

  // Console output (structured for log aggregation)
  console.error('[ERROR]', JSON.stringify(logEntry, null, 2));

  // TODO: Send to error tracking service (Sentry, etc.)
  // if (process.env.SENTRY_DSN) {
  //   Sentry.captureException(error || new Error(message), { extra: context });
  // }

  // TODO: Send to logging service (Datadog, CloudWatch, etc.)
  // if (process.env.LOG_SERVICE_URL) {
  //   fetch(process.env.LOG_SERVICE_URL, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(logEntry)
  //   }).catch(err => console.error('[Logger] Failed to send log:', err));
  // }

  return logEntry;
}

/**
 * Log transaction event
 * @param {string} eventType - Type of transaction (e.g., 'trade_executed', 'deposit_completed')
 * @param {Object} data - Transaction data
 */
function logTransaction(eventType, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: LOG_LEVELS.INFO,
    event_type: 'transaction',
    transaction_type: eventType,
    data: data
  };

  // Console output
  console.log('[TRANSACTION]', JSON.stringify(logEntry, null, 2));

  // TODO: Send to analytics/logging service
  // if (process.env.ANALYTICS_SERVICE_URL) {
  //   fetch(process.env.ANALYTICS_SERVICE_URL, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(logEntry)
  //   }).catch(err => console.error('[Logger] Failed to send transaction log:', err));
  // }

  return logEntry;
}

/**
 * Log security event
 * @param {string} eventType - Type of security event (e.g., 'rate_limit_exceeded', 'invalid_session')
 * @param {Object} data - Event data
 */
function logSecurityEvent(eventType, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: LOG_LEVELS.WARN,
    event_type: 'security',
    security_event_type: eventType,
    data: data
  };

  // Console output
  console.warn('[SECURITY]', JSON.stringify(logEntry, null, 2));

  // TODO: Send to security monitoring service
  // if (process.env.SECURITY_SERVICE_URL) {
  //   fetch(process.env.SECURITY_SERVICE_URL, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(logEntry)
  //   }).catch(err => console.error('[Logger] Failed to send security log:', err));
  // }

  return logEntry;
}

/**
 * Log info message
 * @param {string} message - Info message
 * @param {Object} context - Additional context
 */
function logInfo(message, context = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: LOG_LEVELS.INFO,
    message: message,
    context: context
  };

  console.log('[INFO]', JSON.stringify(logEntry, null, 2));
  return logEntry;
}

/**
 * Log warning message
 * @param {string} message - Warning message
 * @param {Object} context - Additional context
 */
function logWarn(message, context = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: LOG_LEVELS.WARN,
    message: message,
    context: context
  };

  console.warn('[WARN]', JSON.stringify(logEntry, null, 2));
  return logEntry;
}

module.exports = {
  logError,
  logTransaction,
  logSecurityEvent,
  logInfo,
  logWarn,
  LOG_LEVELS
};

-- ============================================
-- Phase 2-3: Security Tables for Nonces, Idempotency, Rate Limiting
-- Run this in your Supabase SQL Editor
-- ============================================

-- Nonces table for replay protection
CREATE TABLE IF NOT EXISTS nonces (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  nonce text NOT NULL,
  used boolean DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, nonce)
);

-- Create index for nonce lookups
CREATE INDEX IF NOT EXISTS nonces_user_id_idx ON nonces(user_id);
CREATE INDEX IF NOT EXISTS nonces_nonce_idx ON nonces(nonce);
CREATE INDEX IF NOT EXISTS nonces_expires_at_idx ON nonces(expires_at);

-- Enable RLS on nonces
ALTER TABLE nonces ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for nonces
DROP POLICY IF EXISTS "Service role full access nonces" ON nonces;
CREATE POLICY "Service role full access nonces"
  ON nonces FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- Idempotency keys table for duplicate request prevention
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  user_id text NOT NULL,
  operation text NOT NULL, -- 'trade', 'withdrawal', 'deposit', etc.
  request_hash text, -- Hash of request body for verification
  response_body jsonb, -- Cached response
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Create indexes for idempotency keys
CREATE INDEX IF NOT EXISTS idempotency_keys_key_idx ON idempotency_keys(idempotency_key);
CREATE INDEX IF NOT EXISTS idempotency_keys_user_id_idx ON idempotency_keys(user_id);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys(expires_at);

-- Enable RLS on idempotency_keys
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for idempotency_keys
DROP POLICY IF EXISTS "Service role full access idempotency_keys" ON idempotency_keys;
CREATE POLICY "Service role full access idempotency_keys"
  ON idempotency_keys FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- Rate limiting table (simple implementation)
CREATE TABLE IF NOT EXISTS rate_limits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  endpoint text NOT NULL,
  request_count integer DEFAULT 1,
  window_start timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, endpoint, window_start)
);

-- Create index for rate limit lookups
CREATE INDEX IF NOT EXISTS rate_limits_user_endpoint_idx ON rate_limits(user_id, endpoint);
CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits(window_start);

-- Enable RLS on rate_limits
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for rate_limits
DROP POLICY IF EXISTS "Service role full access rate_limits" ON rate_limits;
CREATE POLICY "Service role full access rate_limits"
  ON rate_limits FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- Grant permissions
GRANT ALL ON nonces TO service_role;
GRANT ALL ON idempotency_keys TO service_role;
GRANT ALL ON rate_limits TO service_role;

-- Function to clean up expired nonces (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_nonces()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM nonces WHERE expires_at < now();
END;
$$;

-- Function to clean up expired idempotency keys (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_keys()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < now();
END;
$$;

-- Success message
SELECT 'Phase 2-3 security tables created successfully!' AS status;

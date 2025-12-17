-- ============================================
-- Phase 1: TON Connect Session Management
-- Run this in your Supabase SQL Editor
-- ============================================

-- Add columns to custody_wallets for TON session data
DO $$ 
BEGIN
  -- Add ton_wallet_app_name column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'ton_wallet_app_name') THEN
    ALTER TABLE custody_wallets ADD COLUMN ton_wallet_app_name text;
    RAISE NOTICE 'Added ton_wallet_app_name column to custody_wallets';
  END IF;
  
  -- Add tonconnect_session_data_enc column for encrypted session data
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'tonconnect_session_data_enc') THEN
    ALTER TABLE custody_wallets ADD COLUMN tonconnect_session_data_enc text;
    RAISE NOTICE 'Added tonconnect_session_data_enc column to custody_wallets';
  END IF;
  
  -- Add ton_network column (mainnet/testnet)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'ton_network') THEN
    ALTER TABLE custody_wallets ADD COLUMN ton_network text DEFAULT 'mainnet';
    RAISE NOTICE 'Added ton_network column to custody_wallets';
  END IF;
  
  -- Add ton_session_connected_at timestamp
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'ton_session_connected_at') THEN
    ALTER TABLE custody_wallets ADD COLUMN ton_session_connected_at timestamptz;
    RAISE NOTICE 'Added ton_session_connected_at column to custody_wallets';
  END IF;
END $$;

-- Create sessions table for Phase 2 (JWT session tokens)
CREATE TABLE IF NOT EXISTS sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  session_token text UNIQUE NOT NULL,
  ton_address text NOT NULL, -- TON address used for authentication
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  last_used_at timestamptz DEFAULT now(),
  user_agent text,
  ip_address text,
  is_revoked boolean DEFAULT false
);

-- Create indexes for sessions
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_session_token_idx ON sessions(session_token);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_ton_address_idx ON sessions(ton_address);

-- Enable RLS on sessions
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for sessions
DROP POLICY IF EXISTS "Service role full access sessions" ON sessions;
CREATE POLICY "Service role full access sessions"
  ON sessions FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- Grant permissions
GRANT ALL ON sessions TO service_role;

-- Success message
SELECT 'Phase 1 session management migration completed successfully!' AS status;

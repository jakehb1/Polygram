-- ============================================
-- Polygram Supabase Setup Script
-- Run this in your Supabase SQL Editor
-- ============================================

-- 1. Create Tables
-- ============================================

-- Custody wallets table (supports both Solana and Polygon)
CREATE TABLE IF NOT EXISTS custody_wallets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text UNIQUE NOT NULL,
  polygon_address text NOT NULL,
  polygon_secret_enc text NOT NULL,
  solana_address text,
  solana_secret_enc text,
  clob_api_key_enc text,
  clob_api_secret_enc text,
  clob_api_passphrase_enc text,
  clob_registered boolean DEFAULT false,
  usdc_approved boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Add Solana columns if table already exists
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'solana_address') THEN
    ALTER TABLE custody_wallets ADD COLUMN solana_address text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'solana_secret_enc') THEN
    ALTER TABLE custody_wallets ADD COLUMN solana_secret_enc text;
  END IF;
END $$;

-- User balances table
CREATE TABLE IF NOT EXISTS user_balances (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text UNIQUE NOT NULL,
  usdc_available numeric DEFAULT 0,
  usdc_locked numeric DEFAULT 0,
  sol_balance numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- Add sol_balance column if table already exists
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'user_balances' AND column_name = 'sol_balance') THEN
    ALTER TABLE user_balances ADD COLUMN sol_balance numeric DEFAULT 0;
  END IF;
END $$;

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  market_id text,
  market_slug text,
  clob_token_id text,
  side text,
  shares numeric DEFAULT 0,
  avg_price numeric,
  current_value numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Create Indexes
-- ============================================

CREATE INDEX IF NOT EXISTS custody_wallets_user_id_idx ON custody_wallets(user_id);
CREATE INDEX IF NOT EXISTS user_balances_user_id_idx ON user_balances(user_id);
CREATE INDEX IF NOT EXISTS positions_user_id_idx ON positions(user_id);
CREATE INDEX IF NOT EXISTS positions_market_id_idx ON positions(market_id);

-- 3. Enable Row Level Security (RLS)
-- ============================================

ALTER TABLE custody_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

-- 4. Drop existing policies if they exist (for clean setup)
-- ============================================

DROP POLICY IF EXISTS "Users can view own wallet" ON custody_wallets;
DROP POLICY IF EXISTS "Service role full access wallets" ON custody_wallets;
DROP POLICY IF EXISTS "Users can view own balance" ON user_balances;
DROP POLICY IF EXISTS "Service role full access balances" ON user_balances;
DROP POLICY IF EXISTS "Users can view own positions" ON positions;
DROP POLICY IF EXISTS "Service role full access positions" ON positions;

-- 5. Create RLS Policies
-- ============================================

-- IMPORTANT: When using service_role key with createClient(), RLS is automatically bypassed.
-- These policies are for additional security and for any future direct database access.
-- The service_role key will work regardless of these policies.

-- Custody Wallets Policies
-- Service role has full access (though it bypasses RLS anyway)
CREATE POLICY "Service role full access wallets"
  ON custody_wallets FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- User Balances Policies
CREATE POLICY "Service role full access balances"
  ON user_balances FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- Positions Policies
CREATE POLICY "Service role full access positions"
  ON positions FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR
    current_setting('request.jwt.claims', true)::json IS NULL
  );

-- 6. Create Functions for Auto-updating updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers
DROP TRIGGER IF EXISTS update_custody_wallets_updated_at ON custody_wallets;
CREATE TRIGGER update_custody_wallets_updated_at
  BEFORE UPDATE ON custody_wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_balances_updated_at ON user_balances;
CREATE TRIGGER update_user_balances_updated_at
  BEFORE UPDATE ON user_balances
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_positions_updated_at ON positions;
CREATE TRIGGER update_positions_updated_at
  BEFORE UPDATE ON positions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 7. Grant Permissions (if needed)
-- ============================================

-- Ensure service_role can access tables
GRANT ALL ON custody_wallets TO service_role;
GRANT ALL ON user_balances TO service_role;
GRANT ALL ON positions TO service_role;

-- 8. Verify Setup
-- ============================================

-- Check tables exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'custody_wallets') THEN
    RAISE EXCEPTION 'Table custody_wallets does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_balances') THEN
    RAISE EXCEPTION 'Table user_balances does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'positions') THEN
    RAISE EXCEPTION 'Table positions does not exist';
  END IF;
  RAISE NOTICE 'All tables created successfully';
END $$;

-- Check RLS is enabled
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'custody_wallets') THEN
    RAISE EXCEPTION 'RLS not enabled on custody_wallets';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'user_balances') THEN
    RAISE EXCEPTION 'RLS not enabled on user_balances';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'positions') THEN
    RAISE EXCEPTION 'RLS not enabled on positions';
  END IF;
  RAISE NOTICE 'RLS enabled on all tables';
END $$;

-- Success message
SELECT 'Supabase setup completed successfully!' AS status;


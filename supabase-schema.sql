-- =============================================
-- POLYSIGHT SCHEMA ADDITIONS
-- Run this to add CLOB credential columns to your existing custody_wallets table
-- =============================================

-- Add CLOB credential columns to custody_wallets
ALTER TABLE custody_wallets
ADD COLUMN IF NOT EXISTS clob_api_key_enc text,
ADD COLUMN IF NOT EXISTS clob_api_secret_enc text,
ADD COLUMN IF NOT EXISTS clob_api_passphrase_enc text,
ADD COLUMN IF NOT EXISTS clob_registered boolean default false,
ADD COLUMN IF NOT EXISTS usdc_approved boolean default false;

-- Optional: Add index for faster lookups on registered wallets
CREATE INDEX IF NOT EXISTS custody_wallets_clob_registered_idx 
ON custody_wallets (clob_registered) WHERE clob_registered = true;

-- =============================================
-- YOUR EXISTING TABLES (for reference)
-- These should already exist - no changes needed
-- =============================================

-- user_balances: 
--   user_id, usdc_available, usdc_locked, updated_at

-- deposits:
--   id, user_id, chain, token, tx_hash, from_address, to_address, 
--   amount, block_number, deposited_at

-- positions:
--   id, user_id, clob_token_id, avg_price, shares, updated_at

-- trades:
--   id, user_id, market_slug, clob_token_id, side, price, size, 
--   order_id, status, raw, created_at

-- custody_wallets:
--   id, user_id, polygon_address, polygon_secret_enc, created_at, updated_at
--   + NEW: clob_api_key_enc, clob_api_secret_enc, clob_api_passphrase_enc, 
--          clob_registered, usdc_approved

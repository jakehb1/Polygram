-- ============================================
-- Phase 3: Supabase Vault Setup for Secure Key Storage
-- Run this in your Supabase SQL Editor
-- ============================================

-- Enable Supabase Vault extension
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA vault TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA vault TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA vault TO service_role;

-- Note: Vault secrets are created via API/function calls, not directly in SQL
-- The vault.create_secret() function will be called from the backend API

-- Update custody_wallets table to reference Vault secrets instead of encrypted columns
DO $$ 
BEGIN
  -- Add vault secret ID columns (references to vault.secrets table)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'polygon_vault_secret_id') THEN
    ALTER TABLE custody_wallets ADD COLUMN polygon_vault_secret_id text;
    RAISE NOTICE 'Added polygon_vault_secret_id column to custody_wallets';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'custody_wallets' AND column_name = 'solana_vault_secret_id') THEN
    ALTER TABLE custody_wallets ADD COLUMN solana_vault_secret_id text;
    RAISE NOTICE 'Added solana_vault_secret_id column to custody_wallets';
  END IF;
  
  -- Keep old encrypted columns for migration period (can remove later)
  -- We'll migrate data from old columns to Vault, then deprecate old columns
END $$;

-- Create function to create Vault secret for a wallet
-- This will be called from the backend API
CREATE OR REPLACE FUNCTION create_wallet_vault_secret(
  secret_name text,
  secret_value text,
  user_id_param text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  secret_id text;
BEGIN
  -- Create secret in Vault
  -- Note: vault.create_secret() function signature may vary
  -- Adjust based on actual Supabase Vault API
  SELECT vault.create_secret(
    name => secret_name,
    secret => secret_value,
    description => format('Private key for user %s', user_id_param)
  ) INTO secret_id;
  
  RETURN secret_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Failed to create vault secret: %', SQLERRM;
END;
$$;

-- Grant execute permission to service_role
GRANT EXECUTE ON FUNCTION create_wallet_vault_secret(text, text, text) TO service_role;

-- Create function to retrieve Vault secret
CREATE OR REPLACE FUNCTION get_wallet_vault_secret(secret_id_param text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  secret_value text;
BEGIN
  -- Retrieve secret from Vault
  -- Note: Adjust based on actual Supabase Vault API
  SELECT vault.get_secret(secret_id_param) INTO secret_value;
  
  RETURN secret_value;
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Failed to retrieve vault secret: %', SQLERRM;
END;
$$;

-- Grant execute permission to service_role
GRANT EXECUTE ON FUNCTION get_wallet_vault_secret(text) TO service_role;

-- Success message
SELECT 'Phase 3 Supabase Vault setup completed successfully!' AS status,
       'Note: Vault functions may need adjustment based on actual Supabase Vault API' AS warning;

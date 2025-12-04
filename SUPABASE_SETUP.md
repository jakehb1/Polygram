# Supabase Setup Guide

## Quick Setup

1. **Open Supabase SQL Editor**
   - Go to your Supabase project dashboard
   - Navigate to SQL Editor
   - Click "New query"

2. **Run the Setup Script**
   - Copy the entire contents of `supabase-setup.sql`
   - Paste into the SQL Editor
   - Click "Run" (or press Cmd/Ctrl + Enter)

3. **Verify Setup**
   - Go to Table Editor
   - You should see three tables:
     - `custody_wallets`
     - `user_balances`
     - `positions`
   - Check that RLS is enabled (you'll see "RLS enabled" badge)

## How RLS Works with Service Role

**Important**: When you use the `service_role` key in your API (which you should), Supabase **automatically bypasses RLS**. This means:

- ✅ Your API will work correctly even with RLS enabled
- ✅ RLS provides security for direct database access
- ✅ The policies in the setup script are for additional security layers

## Testing the Setup

After running the setup script, test it:

1. **Test Wallet Creation** (via API):
   ```bash
   curl https://your-app.vercel.app/api/wallet?telegram_id=test_user_123
   ```

2. **Check Supabase Table**:
   - Go to Table Editor → `custody_wallets`
   - You should see a new row with the test user's wallet

3. **Test Balance Query**:
   ```bash
   curl https://your-app.vercel.app/api/balances?telegram_id=test_user_123
   ```

## Troubleshooting

### "RLS disabled" warning
- The setup script enables RLS automatically
- If you see this warning, run the RLS enable commands manually:
  ```sql
  ALTER TABLE custody_wallets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE user_balances ENABLE ROW LEVEL SECURITY;
  ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
  ```

### API returns errors
- Verify `SUPABASE_SERVICE_KEY` is set correctly in Vercel
- Make sure you're using the `service_role` key (not `anon` key)
- Check that the key starts with `eyJ...` (it's a JWT)

### Tables not created
- Check for SQL errors in the Supabase SQL Editor
- Verify you have proper permissions in Supabase
- Try running the table creation statements individually

## Security Notes

1. **Service Role Key**: Keep this secret! Never commit it to git or expose it publicly
2. **Encryption Key**: The `ENCRYPTION_KEY` must be the same across all deployments
3. **RLS**: While service_role bypasses RLS, having it enabled is still good practice
4. **Backup**: Regularly backup your Supabase database

## Next Steps

After setup is complete:
1. Set environment variables in Vercel (see README.md)
2. Deploy your application
3. Test wallet creation and balance queries
4. Monitor Supabase logs for any issues


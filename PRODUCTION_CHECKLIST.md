# Production Deployment Checklist

## ✅ Critical Issues Fixed

### 1. Encryption Key (FIXED)
- **Issue**: Encryption key was randomly generated, making decryption impossible
- **Fix**: Now requires `ENCRYPTION_KEY` environment variable
- **Action Required**: Set `ENCRYPTION_KEY` in Vercel (64 hex characters)

## 🔒 Security Setup Required

### 1. Enable Row Level Security (RLS) in Supabase

Run this SQL in your Supabase SQL Editor:

```sql
-- Enable RLS on all tables
ALTER TABLE custody_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own wallet
CREATE POLICY "Users can view own wallet"
  ON custody_wallets FOR SELECT
  USING (auth.uid()::text = user_id);

-- Policy: Service role can do everything (for API)
CREATE POLICY "Service role full access"
  ON custody_wallets FOR ALL
  USING (auth.role() = 'service_role');

-- Policy: Users can only see their own balances
CREATE POLICY "Users can view own balance"
  ON user_balances FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Service role full access balances"
  ON user_balances FOR ALL
  USING (auth.role() = 'service_role');

-- Policy: Users can only see their own positions
CREATE POLICY "Users can view own positions"
  ON positions FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Service role full access positions"
  ON positions FOR ALL
  USING (auth.role() = 'service_role');
```

**Note**: Since we're using service_role key in the API, RLS policies allow service_role full access. For additional security, you could restrict service_role operations further.

### 2. Environment Variables

Set these in Vercel (Settings → Environment Variables):

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJI... (service_role key from Supabase)
ENCRYPTION_KEY=<generate with: openssl rand -hex 32>
POLYGON_RPC=https://polygon-rpc.com (or use Alchemy/Infura for better reliability)
```

**Generate Encryption Key:**
```bash
openssl rand -hex 32
```

### 3. CORS Configuration

Currently set to `*` (allow all). For production, consider restricting:

```javascript
// In each API file, update:
res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
```

Set `ALLOWED_ORIGIN` in Vercel to your domain (e.g., `https://your-app.vercel.app`)

## 📋 Pre-Deployment Checklist

### Database
- [ ] Tables created in Supabase
- [ ] Indexes created
- [ ] RLS enabled and policies set
- [ ] Test wallet creation works
- [ ] Test balance query works

### Environment Variables
- [ ] `SUPABASE_URL` set
- [ ] `SUPABASE_SERVICE_KEY` set (service_role key)
- [ ] `ENCRYPTION_KEY` set (64 hex characters)
- [ ] `POLYGON_RPC` set (optional, defaults to public RPC)

### Security
- [ ] RLS policies enabled
- [ ] Encryption key is strong and secure
- [ ] Service role key is kept secret
- [ ] CORS configured (if restricting)
- [ ] Error messages don't leak sensitive info

### Testing
- [ ] Wallet creation works
- [ ] Wallet retrieval works
- [ ] Balance fetching works
- [ ] On-chain balance checking works
- [ ] Multiple users can have wallets
- [ ] No wallet conflicts

### Monitoring
- [ ] Set up error tracking (Sentry, etc.)
- [ ] Monitor Supabase usage
- [ ] Monitor API response times
- [ ] Set up alerts for errors

## 🚨 Known Limitations

1. **Encryption**: Using AES-256-CBC. For production, consider:
   - Using Supabase Vault for key management
   - Or AWS KMS / Google Cloud KMS
   - Or hardware security modules (HSM)

2. **Private Keys**: Stored encrypted in database. Consider:
   - Using hardware wallets for large amounts
   - Multi-sig wallets
   - Key sharding

3. **RLS**: Currently allows service_role full access. For stricter security:
   - Implement API-level user authentication
   - Use JWT tokens to verify user identity
   - Restrict service_role operations

## 🔍 Post-Deployment Testing

1. **Create a test wallet:**
   ```
   GET /api/wallet?telegram_id=test_user_123
   ```

2. **Check balance:**
   ```
   GET /api/balances?telegram_id=test_user_123
   ```

3. **Verify wallet is in Supabase:**
   - Check `custody_wallets` table
   - Verify encryption is working (secret should be encrypted)
   - Verify user_balances record exists

4. **Test with real funding:**
   - Send small amount of USDC to Polygon address
   - Check balance updates correctly

## 📝 Notes

- The encryption key MUST be the same across all serverless function invocations
- If you lose the encryption key, all encrypted wallets become unrecoverable
- Store the encryption key securely (Vercel environment variables are encrypted at rest)
- Consider key rotation strategy for long-term security


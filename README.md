# Polygram

Telegram Mini App for trading on Polymarket with custodial wallets.

## Setup

### 1. Setup Supabase Database

**Option A: Use the setup script (Recommended)**

1. Open your Supabase project dashboard
2. Go to SQL Editor
3. Copy and paste the contents of `supabase-setup.sql`
4. Click "Run" to execute

This script will:
- Create all required tables
- Set up indexes for performance
- Enable Row Level Security (RLS)
- Create RLS policies for service_role access
- Set up auto-update triggers for `updated_at` columns

**Option B: Manual setup**

If you prefer to run SQL manually, see `supabase-setup.sql` for the complete setup script.

**Important**: The setup script includes RLS policies that allow the `service_role` key (used by your API) to access all data. This is required for the API to function correctly.

### 2. Set Environment Variables in Vercel

Go to Vercel → Your Project → Settings → Environment Variables and add:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJI...  (use service_role key from Supabase)
ENCRYPTION_KEY=<generate with: openssl rand -hex 32>
POLYGON_RPC=https://polygon-rpc.com (optional, defaults to public RPC)
```

**Generate Encryption Key:**
```bash
openssl rand -hex 32
```

**Important**: 
- Use the `service_role` key from Supabase (not the `anon` key)
- The `ENCRYPTION_KEY` must be exactly 64 hex characters (32 bytes)
- Store this key securely - if lost, encrypted wallets cannot be recovered

### 3. Deploy to Vercel

Via GitHub:
1. Push this repo to GitHub
2. Connect to Vercel
3. Deploy

Via CLI:
```bash
npm install -g vercel
vercel --prod
```

### 4. Test

1. Visit: `https://your-app.vercel.app/api/test`
   - Should return `{"ok":true,...}`

2. Visit: `https://your-app.vercel.app/api/markets?kind=trending&limit=5`
   - Should return Polymarket data

3. Main app: `https://your-app.vercel.app/?bypass=true`
   - Bypasses passkey for testing

## Passkeys

Valid passkeys: `EARLYBIRD`, `POLYGRAM2024`, `TRADEPRO`, `BETAACCESS`, `PUBLICLABS`

Edit in `index.html` to change.

## Project Structure

```
/
├── index.html          # Frontend
├── api/
│   ├── test.js         # Health check
│   ├── markets.js      # Polymarket Gamma API
│   ├── wallet.js       # Wallet management
│   └── balances.js     # Balance queries
├── vercel.json         # Vercel config
└── package.json
```

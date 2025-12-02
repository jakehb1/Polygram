# Polysight — Polymarket Telegram Mini App

A Telegram Mini App for trading on Polymarket with **custodial wallets** stored in Supabase.

## Features

- **Custodial Wallets** — Each Telegram user gets their own Polygon wallet
- **Supabase Storage** — Wallets securely stored with encrypted private keys
- **CLOB Trading** — Real buy/sell orders via Polymarket CLOB
- **Live Markets** — Browse trending, new, and sports markets
- **Balance Tracking** — USDC.e balance and position values

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Telegram App   │────▶│  Vercel APIs    │────▶│    Supabase     │
│  (index.html)   │     │  (Serverless)   │     │  (PostgreSQL)   │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  Polymarket     │
                        │  CLOB + Gamma   │
                        └─────────────────┘
```

## Setup

### 1. Supabase Database

Create a new Supabase project and run the schema:

```sql
-- Run this in Supabase SQL Editor
-- See: supabase-schema.sql
```

**Required tables:**
- `wallets` — Stores Telegram user wallets with encrypted private keys
- `trades` — Logs all trade attempts
- `deposits` — Tracks deposits (optional)

### 2. Environment Variables

Set these in Vercel (Project → Settings → Environment Variables):

```bash
# Supabase (Required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Wallet encryption (Required - generate a strong random string)
WALLET_ENCRYPTION_KEY=your-32-char-encryption-key-here

# Polygon RPC (Optional)
POLYGON_RPC=https://polygon-rpc.com

# Polymarket APIs
POLYMARKET_DATA_URL=https://data-api.polymarket.com
CLOB_HOST=https://clob.polymarket.com
CLOB_CHAIN_ID=137
```

### 3. Deploy to Vercel

```bash
npm install
vercel --prod
```

### 4. Setup Telegram Bot

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Use `/setmenubutton` to set your Vercel URL as the Mini App
3. Users access the app via your bot

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/wallet` | GET/POST | Create/get wallet for Telegram user |
| `/api/balances` | GET | Get USDC balance and position value |
| `/api/clob-register` | POST | Register wallet with Polymarket CLOB |
| `/api/approve` | POST | Approve USDC spending for trading |
| `/api/trade` | POST | Submit buy/sell order |
| `/api/markets` | GET | Fetch live markets from Gamma API |
| `/api/positions` | GET | Get user's open positions |

## User Flow

1. **Open Mini App** — User opens app via Telegram bot
2. **Wallet Created** — App auto-creates Polygon wallet (stored in Supabase)
3. **Deposit USDC** — User sends USDC.e to their wallet address
4. **Register CLOB** — One-time registration to enable trading
5. **Approve USDC** — One-time approval for USDC spending
6. **Trade** — User can now buy YES/NO on markets

## Security Notes

⚠️ **Production Considerations:**

- Replace XOR encryption with proper AES-256-GCM
- Add rate limiting to prevent abuse
- Implement withdrawal limits and delays
- Add 2FA for large withdrawals
- Use HSM for production key management
- Regular security audits

## File Structure

```
polysight/
├── api/
│   ├── wallet.js        # Wallet management (Supabase)
│   ├── balances.js      # Balance checking
│   ├── clob-register.js # CLOB API key registration
│   ├── approve.js       # USDC approval transactions
│   ├── trade.js         # Order submission
│   ├── markets.js       # Gamma API proxy
│   ├── positions.js     # User positions
│   ├── trades.js        # Trade history
│   ├── activity.js      # User activity
│   ├── categories.js    # Market categories
│   └── deposit.js       # Deposit info
├── public/
│   └── index.html       # Telegram Mini App UI
├── package.json
├── supabase-schema.sql  # Database schema
├── .env.example
└── README.md
```

## Development

```bash
# Install dependencies
npm install

# Run locally (requires .env file)
vercel dev

# Open in browser
open http://localhost:3000?telegram_id=test123
```

## License

MIT

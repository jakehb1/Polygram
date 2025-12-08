# Price Tracking System

This document explains how real historical price data is tracked and displayed in the app.

## Overview

The app now tracks real price history for markets, enabling accurate historical price graphs instead of simulated data.

## Database Schema

### `market_price_history` Table

Stores price snapshots for each market outcome over time:

- `market_id`: Market identifier
- `condition_id`: Polymarket condition ID
- `outcome_index`: Which outcome (0, 1, 2, etc.)
- `outcome_name`: Name of the outcome
- `price`: Price at time of snapshot (0-1)
- `volume`: Volume at time of snapshot
- `liquidity`: Liquidity at time of snapshot
- `timestamp`: When the snapshot was taken

**Indexes:**
- Fast queries by `market_id` and `timestamp`
- Unique constraint on `(market_id, outcome_index, timestamp)` to prevent duplicates

**Auto-cleanup:**
- Data older than 90 days is automatically removed
- Prevents database from growing indefinitely

## How It Works

### 1. Price Snapshot Collection

During market sync (`/api/sync-markets`):
- For each market, stores price snapshots for all outcomes
- Captures current price, volume, and liquidity
- Timestamped for historical tracking
- Upserts to avoid duplicates if sync runs multiple times per minute

### 2. Historical Data Retrieval

When viewing market detail (`/api/market-history`):
- Queries database for price history within selected time range
- Groups data by outcome
- Returns structured data for graph rendering
- Falls back to simulated data if database is empty

### 3. Graph Display

Frontend (`index.html`):
- Fetches historical data from `/api/market-history`
- Renders graph using real price snapshots
- Updates when time range changes (1H, 6H, 1D, 1W, 1M, ALL)
- Shows Y-axis percentage labels

## Data Flow

```
Market Sync (every 5 minutes)
    ↓
Store price snapshots in database
    ↓
User opens market detail view
    ↓
Fetch historical data from database
    ↓
Render graph with real price history
```

## Setup

1. **Run Migration:**
   ```sql
   -- Execute supabase-markets-migration.sql
   -- This creates the market_price_history table
   ```

2. **Start Syncing:**
   ```bash
   # Initial sync
   GET /api/sync-markets?full=true
   
   # Set up cron for automatic syncing (every 5 minutes)
   ```

3. **Verify:**
   ```sql
   -- Check if price history is being tracked
   SELECT COUNT(*) FROM market_price_history;
   SELECT * FROM market_price_history ORDER BY timestamp DESC LIMIT 10;
   ```

## Benefits

✅ **Real Historical Data**: Actual price movements over time  
✅ **Accurate Graphs**: Shows true market behavior  
✅ **Time Range Support**: View history for any time period  
✅ **Automatic Tracking**: No manual intervention needed  
✅ **Efficient Storage**: Auto-cleanup prevents database bloat  

## Timeline

- **Day 1**: First sync creates initial price snapshots
- **Day 7**: 1 week of historical data available
- **Day 30**: 1 month of historical data available
- **Day 90+**: Old data automatically cleaned up

## Notes

- Price tracking begins after first sync
- Historical data accumulates over time
- Graphs show "simulated" data until enough history is collected
- Database automatically manages storage with 90-day cleanup


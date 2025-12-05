#!/usr/bin/env node
/**
 * Polygram Flow Testing Script
 * 
 * Tests the complete user flows:
 * 1. Wallet creation and retrieval
 * 2. Wallet funding flow
 * 3. Market purchase/trading flow
 * 
 * Usage:
 *   node test-flows.js
 */

const https = require('https');
const http = require('http');

// Configuration
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const TEST_USER_ID = `flow_test_${Date.now()}`;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ ${message}`, 'blue');
}

function logStep(message) {
  log(`\n▶ ${message}`, 'cyan');
}

function logSection(message) {
  log('\n' + '='.repeat(70), 'magenta');
  log(message, 'magenta');
  log('='.repeat(70), 'magenta');
}

// HTTP request helper
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

// Test wallet creation
async function testWalletCreation() {
  logStep('Testing Wallet Creation');
  
  try {
    const response = await makeRequest(`${BASE_URL}/api/wallet?telegram_id=${TEST_USER_ID}`);
    
    if (response.status === 200 && response.data.success) {
      const wallet = response.data.wallet;
      logSuccess('Wallet created successfully');
      logInfo(`  User ID: ${TEST_USER_ID}`);
      logInfo(`  Polygon Address: ${wallet.polygon}`);
      logInfo(`  Solana Address: ${wallet.solana}`);
      logInfo(`  Is New: ${response.data.isNew}`);
      
      return { success: true, wallet };
    } else {
      logError(`Wallet creation failed: ${response.status}`);
      if (response.data.message) {
        logError(`  Error: ${response.data.message}`);
      }
      return { success: false };
    }
  } catch (error) {
    logError(`Wallet creation error: ${error.message}`);
    return { success: false };
  }
}

// Test wallet retrieval
async function testWalletRetrieval() {
  logStep('Testing Wallet Retrieval (should return existing wallet)');
  
  try {
    const response = await makeRequest(`${BASE_URL}/api/wallet?telegram_id=${TEST_USER_ID}`);
    
    if (response.status === 200 && response.data.success) {
      if (!response.data.isNew) {
        logSuccess('Wallet retrieved successfully (existing wallet found)');
        logInfo(`  Polygon: ${response.data.wallet.polygon.substring(0, 20)}...`);
        logInfo(`  Solana: ${response.data.wallet.solana.substring(0, 20)}...`);
        return { success: true, wallet: response.data.wallet };
      } else {
        logError('Wallet was created again instead of retrieved');
        return { success: false };
      }
    } else {
      logError(`Wallet retrieval failed: ${response.status}`);
      return { success: false };
    }
  } catch (error) {
    logError(`Wallet retrieval error: ${error.message}`);
    return { success: false };
  }
}

// Test balance query
async function testBalanceQuery(wallet) {
  logStep('Testing Balance Query');
  
  try {
    const response = await makeRequest(`${BASE_URL}/api/balances?telegram_id=${TEST_USER_ID}`);
    
    if (response.status === 200 && response.data.success) {
      logSuccess('Balance query successful');
      logInfo(`  USDC: $${response.data.usdc.toFixed(2)}`);
      logInfo(`  SOL: ${response.data.sol || 0}`);
      logInfo(`  Positions: $${response.data.positions.toFixed(2)}`);
      logInfo(`  Total: $${response.data.total.toFixed(2)}`);
      
      if (response.data.walletStatus) {
        logInfo(`  Wallet exists: ${response.data.walletStatus.exists}`);
        logInfo(`  CLOB registered: ${response.data.walletStatus.clobRegistered || false}`);
        logInfo(`  USDC approved: ${response.data.walletStatus.usdcApproved || false}`);
      }
      
      return { success: true, balance: response.data };
    } else {
      logError(`Balance query failed: ${response.status}`);
      if (response.data.error) {
        logError(`  Error: ${response.data.error}`);
      }
      return { success: false };
    }
  } catch (error) {
    logError(`Balance query error: ${error.message}`);
    return { success: false };
  }
}

// Test funding flow
async function testFundingFlow(wallet) {
  logSection('WALLET FUNDING FLOW TEST');
  
  logStep('Step 1: Get Funding Instructions (USDC)');
  
  try {
    const response = await makeRequest(
      `${BASE_URL}/api/fund?telegram_id=${TEST_USER_ID}&currency=usdc&wallet_address=${wallet.polygon}`
    );
    
    if (response.status === 200 && response.data.success) {
      logSuccess('Funding instructions retrieved');
      logInfo(`  Currency: ${response.data.currency}`);
      logInfo(`  Network: ${response.data.network}`);
      logInfo(`  Address: ${response.data.address}`);
      logInfo(`  Minimum: $${response.data.minAmount}`);
      logInfo(`  Instructions: ${response.data.instructions}`);
      
      logStep('Step 2: Initiate Funding (POST)');
      
      const fundResponse = await makeRequest(`${BASE_URL}/api/fund`, {
        method: 'POST',
        body: {
          telegram_id: TEST_USER_ID,
          currency: 'usdc',
          amount: 50,
          payment_method: 'crypto',
          wallet_address: wallet.polygon,
        },
      });
      
      if (fundResponse.status === 200 && fundResponse.data.success) {
        logSuccess('Funding request created');
        logInfo(`  Funding ID: ${fundResponse.data.funding_id}`);
        logInfo(`  Amount: $${fundResponse.data.amount}`);
        logInfo(`  Status: ${fundResponse.data.status}`);
        logInfo(`  Instructions: ${fundResponse.data.instructions}`);
        
        return { success: true, funding: fundResponse.data };
      } else {
        logError(`Funding initiation failed: ${fundResponse.status}`);
        if (fundResponse.data.message) {
          logError(`  Error: ${fundResponse.data.message}`);
        }
        return { success: false };
      }
    } else {
      logError(`Funding instructions failed: ${response.status}`);
      return { success: false };
    }
  } catch (error) {
    logError(`Funding flow error: ${error.message}`);
    return { success: false };
  }
}

// Test market purchase flow
async function testMarketPurchaseFlow(wallet) {
  logSection('MARKET PURCHASE FLOW TEST');
  
  logStep('Step 1: Get Available Markets');
  
  try {
    const marketsResponse = await makeRequest(`${BASE_URL}/api/markets?kind=trending&limit=5`);
    
    if (marketsResponse.status !== 200 || !marketsResponse.data.markets || marketsResponse.data.markets.length === 0) {
      logError('No markets available for testing');
      return { success: false };
    }
    
    const markets = marketsResponse.data.markets;
    const testMarket = markets[0];
    
    logSuccess(`Found ${markets.length} markets`);
    logInfo(`  Testing with market: ${testMarket.question?.substring(0, 50)}...`);
    logInfo(`  Market ID: ${testMarket.id || testMarket.conditionId}`);
    
    if (!wallet || !wallet.polygon) {
      logError('Wallet address required for trade test');
      return { success: false };
    }
    
    logStep('Step 2: Execute Trade (Purchase)');
    
    const marketId = testMarket.id || testMarket.conditionId || testMarket.condition_id;
    const tradeResponse = await makeRequest(`${BASE_URL}/api/trade`, {
      method: 'POST',
      body: {
        telegram_id: TEST_USER_ID,
        market_id: marketId,
        condition_id: marketId,
        outcome_index: 0,
        side: 'yes',
        amount: 10.00,
        wallet_address: wallet.polygon,
      },
    });
    
    if (tradeResponse.status === 200 && tradeResponse.data.success) {
      logSuccess('Trade executed successfully');
      logInfo(`  Trade ID: ${tradeResponse.data.trade_id}`);
      logInfo(`  Market ID: ${tradeResponse.data.market_id}`);
      logInfo(`  Side: ${tradeResponse.data.side}`);
      logInfo(`  Amount: $${tradeResponse.data.amount}`);
      logInfo(`  Shares: ${tradeResponse.data.shares}`);
      logInfo(`  Price: ${tradeResponse.data.price}`);
      logInfo(`  Message: ${tradeResponse.data.message}`);
      
      return { success: true, trade: tradeResponse.data };
    } else {
      logError(`Trade execution failed: ${tradeResponse.status}`);
      if (tradeResponse.data.message) {
        logError(`  Error: ${tradeResponse.data.message}`);
      }
      if (tradeResponse.data.error) {
        logError(`  Error code: ${tradeResponse.data.error}`);
      }
      return { success: false };
    }
  } catch (error) {
    logError(`Market purchase flow error: ${error.message}`);
    return { success: false };
  }
}

// Test payout flow
async function testPayoutFlow() {
  logSection('PAYOUT FLOW TEST');
  
  logStep('Step 1: Check for Pending Payouts');
  
  try {
    const response = await makeRequest(`${BASE_URL}/api/payout?telegram_id=${TEST_USER_ID}`);
    
    if (response.status === 200 && response.data.success) {
      logSuccess('Payout query successful');
      logInfo(`  Pending payouts: ${response.data.pending_payouts?.length || 0}`);
      logInfo(`  Total pending: $${response.data.total_pending || 0}`);
      
      // If there are payouts, test claiming one
      if (response.data.pending_payouts && response.data.pending_payouts.length > 0) {
        const payout = response.data.pending_payouts[0];
        
        logStep('Step 2: Claim Payout');
        
        const claimResponse = await makeRequest(`${BASE_URL}/api/payout`, {
          method: 'POST',
          body: {
            telegram_id: TEST_USER_ID,
            position_id: payout.position_id,
            market_id: payout.market_id,
            amount: payout.amount,
            wallet_address: '0x0000000000000000000000000000000000000000',
          },
        });
        
        if (claimResponse.status === 200 && claimResponse.data.success) {
          logSuccess('Payout claimed successfully');
          logInfo(`  Payout ID: ${claimResponse.data.payout_id}`);
          logInfo(`  Amount: $${claimResponse.data.amount}`);
          return { success: true };
        } else {
          logError('Payout claim failed (this is expected if no winning positions)');
          return { success: false, expected: true };
        }
      } else {
        logInfo('No pending payouts (this is normal for new accounts)');
        return { success: true, noPayouts: true };
      }
    } else {
      logError(`Payout query failed: ${response.status}`);
      return { success: false };
    }
  } catch (error) {
    logError(`Payout flow error: ${error.message}`);
    return { success: false };
  }
}

// Main test runner
async function runFlowTests() {
  log('\n' + '='.repeat(70), 'cyan');
  log('Polygram Flow Testing Suite', 'cyan');
  log('='.repeat(70), 'cyan');
  log(`Testing against: ${BASE_URL}`, 'blue');
  log(`Test User ID: ${TEST_USER_ID}`, 'blue');
  
  const results = {
    walletCreation: false,
    walletRetrieval: false,
    balanceQuery: false,
    fundingFlow: false,
    marketPurchase: false,
    payoutFlow: false,
  };
  
  let wallet = null;
  
  // Test wallet creation
  const walletResult = await testWalletCreation();
  results.walletCreation = walletResult.success;
  if (walletResult.success) {
    wallet = walletResult.wallet;
  } else {
    logError('\nCannot continue - wallet creation failed');
    return;
  }
  
  // Test wallet retrieval
  const retrievalResult = await testWalletRetrieval();
  results.walletRetrieval = retrievalResult.success;
  if (retrievalResult.success) {
    wallet = retrievalResult.wallet;
  }
  
  // Test balance query
  results.balanceQuery = (await testBalanceQuery(wallet)).success;
  
  // Test funding flow
  results.fundingFlow = (await testFundingFlow(wallet)).success;
  
  // Test market purchase flow (needs wallet address)
  if (wallet) {
    const purchaseResult = await testMarketPurchaseFlow(wallet);
    results.marketPurchase = purchaseResult.success;
  } else {
    logError('Skipping market purchase test - no wallet available');
  }
  
  // Test payout flow
  const payoutResult = await testPayoutFlow();
  results.payoutFlow = payoutResult.success || payoutResult.noPayouts;
  
  // Summary
  logSection('TEST RESULTS SUMMARY');
  
  const tests = [
    ['Wallet Creation', results.walletCreation],
    ['Wallet Retrieval', results.walletRetrieval],
    ['Balance Query', results.balanceQuery],
    ['Funding Flow', results.fundingFlow],
    ['Market Purchase Flow', results.marketPurchase],
    ['Payout Flow', results.payoutFlow],
  ];
  
  let passed = 0;
  let total = tests.length;
  
  tests.forEach(([name, result]) => {
    if (result) {
      logSuccess(`${name}: PASSED`);
      passed++;
    } else {
      logError(`${name}: FAILED`);
    }
  });
  
  log('\n' + '='.repeat(70), 'cyan');
  log(`Results: ${passed}/${total} flows passed`, passed === total ? 'green' : 'yellow');
  log('='.repeat(70), 'cyan');
  
  if (passed === total) {
    log('\n🎉 All flows tested successfully!', 'green');
    process.exit(0);
  } else {
    log('\n⚠️  Some flows failed. Review the errors above.', 'yellow');
    process.exit(1);
  }
}

// Run tests
if (require.main === module) {
  runFlowTests().catch((error) => {
    logError(`\nFatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runFlowTests };


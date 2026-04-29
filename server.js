const axios = require('axios');

// Configuration from environment variables
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const TICKERS_STR = process.env.TICKERS || 'AAPL,TSLA,SPY,QQQ,NVDA,MSFT,AMD,GOOG';
const MAX_ALERTS_PER_DAY = 5;

// Position tracking for multi-trade management
let activePositions = {}; // { TICKER: { entryPrice, entryTime } }

// Load positions from file on startup
function loadPositions() {
  try {
    const fs = require('fs');
    if (fs.existsSync('positions.json')) {
      const data = fs.readFileSync('positions.json', 'utf8');
      activePositions = JSON.parse(data);
      console.log(`📂 Loaded ${Object.keys(activePositions).length} active positions`);
    }
  } catch (error) {
    console.log(`ℹ️  No saved positions file`);
  }
}

// Save positions to file
function savePositions() {
  try {
    const fs = require('fs');
    fs.writeFileSync('positions.json', JSON.stringify(activePositions, null, 2));
  } catch (error) {
    console.error(`❌ Failed to save positions:`, error.message);
  }
}

// Open a new position
function openPosition(ticker, entryPrice) {
  activePositions[ticker] = {
    entryPrice: parseFloat(entryPrice.toFixed(2)),
    entryTime: new Date().toISOString(),
  };
  savePositions();
  console.log(`📍 Position opened: ${ticker} at $${entryPrice}`);
}

// Close a position
function closePosition(ticker) {
  delete activePositions[ticker];
  savePositions();
  console.log(`✅ Position closed: ${ticker}`);
}

// Check if position exists
function hasOpenPosition(ticker) {
  return activePositions.hasOwnProperty(ticker);
}

// Get position details
function getPosition(ticker) {
  return activePositions[ticker];
}

loadPositions();

console.log(`🌾 Robot Farmer Started`);
console.log(`📊 Tickers: ${TICKERS.join(', ')}`);
console.log(`🚀 Scanning every 5 minutes during market hours (9:30 AM - 4 PM ET)`);
console.log(`📢 Max alerts per day: ${MAX_ALERTS_PER_DAY}`);

// ============================================
// MAIN SCREENER FUNCTION
// ============================================

async function runScreener() {
  const now = new Date();
  
  // Market hours: 9:30 AM - 4:00 PM ET, Monday-Friday
  // Server is UTC: 9:30 AM ET = 2:30 PM UTC (14:30), 4:00 PM ET = 9:00 PM UTC (21:00)
  const isMarketHours = day >= 1 && day <= 5 && hour >= 14 && hour < 21 && (hour > 14 || minute >= 30);
  
  if (!isMarketHours) {
    console.log(`⏰ Outside market hours. Next scan at next market open.`);
    return;
  }

  // Reset alert counter at midnight
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    alertsSentToday = 0;
    lastResetDate = today;
    console.log(`📅 New trading day. Alert counter reset.`);
  }

  console.log(`\n🔍 Scan started at ${now.toLocaleTimeString()}`);
  console.log(`📈 Checking ${TICKERS.length} tickers...`);

  // Monitor exit conditions for active positions
  await monitorExits(results);

  // Filter to only PASS stocks
  const passingStocks = results.filter(r => r.passes).sort((a, b) => b.score - a.score);

  if (passingStocks.length === 0) {
    console.log(`✅ Scan complete. No stocks passed criteria.`);
    return;
  }

  console.log(`✅ Scan complete. ${passingStocks.length} stock(s) passed.`);

  // Send alerts for top stocks (up to MAX_ALERTS_PER_DAY)
  for (let i = 0; i < Math.min(passingStocks.length, MAX_ALERTS_PER_DAY - alertsSentToday); i++) {
    const stock = passingStocks[i];
    
    // Skip if position already open for this ticker
    if (hasOpenPosition(stock.ticker)) {
      console.log(`⏭️  Skipping ${stock.ticker} - position already open`);
      continue;
    }
    
    await sendSlackAlert(stock, i + 1);
    openPosition(stock.ticker, stock.price);
    alertsSentToday++;
  }

  if (alertsSentToday >= MAX_ALERTS_PER_DAY) {
    console.log(`⛔ Max alerts per day (${MAX_ALERTS_PER_DAY}) reached. No more alerts until tomorrow.`);
  }
}

// ============================================
// INDIVIDUAL STOCK SCREENING
// ============================================

async function screenTicker(ticker) {
  try {
    // Fetch daily aggregates (300 calendar days = ~200 trading days for MA200)
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 300); // Last 300 calendar days

    const fromDate = formatDateOnly(from);
    const toDate = formatDateOnly(now);

    const url = `https://api.massive.com/v2/aggs/ticker/${ticker}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=1000&apiKey=${POLYGON_API_KEY}`;

    const response = await axios.get(url);
    const data = response.data;

    if (!data.results || data.results.length < 20) {
      return null; // Not enough data
    }

    const bars = data.results;
    const latestBar = bars[bars.length - 1];

    // 1. HIGHER HIGHS & LOWS (last 5 min vs prior 5 min)
    const recentBars = bars.slice(-5);
    const priorBars = bars.slice(-10, -5);

    const latestHigh = Math.max(...recentBars.map(b => b.h));
    const latestLow = Math.min(...recentBars.map(b => b.l));
    const priorHigh = Math.max(...priorBars.map(b => b.h));
    const priorLow = Math.min(...priorBars.map(b => b.l));

    const higherHighs = latestHigh > priorHigh;
    const higherLows = latestLow > priorLow;

    // 2. MOVING AVERAGES (50 & 200 minute)
    const ma50 = calculateSMA(bars, 50);
    const ma200 = calculateSMA(bars, 200);
    const ma50_prev = calculateSMA(bars.slice(0, -1), 50);
    const ma200_prev = calculateSMA(bars.slice(0, -1), 200);

    const closeAboveMAs = latestBar.c > ma50 && latestBar.c > ma200;
    const masRising = ma50 > ma50_prev && ma200 > ma200_prev;

    // 3. VOLUME CONFIRMATION
    const avgVolume = calculateSMA(bars, 20, 'v');
    const volumeRatio = latestBar.v / avgVolume;
    const volumeConfirm = volumeRatio >= 1.0;

    // 4. RSI (14-PERIOD)
    const rsi = calculateRSI(bars, 14);
    const rsiStrong = rsi > 50;

    // PASS/FAIL
    const passes = higherHighs && higherLows && closeAboveMAs && masRising && volumeConfirm && rsiStrong;

    // COMPOSITE SCORE
    const score = calculateScore(rsi, volumeRatio, latestBar.c, ma200);

    return {
      ticker,
      passes,
      price: parseFloat(latestBar.c.toFixed(2)),
      rsi: parseFloat(rsi.toFixed(1)),
      ma50: parseFloat(ma50.toFixed(2)),
      ma200: parseFloat(ma200.toFixed(2)),
      volumeRatio: parseFloat(volumeRatio.toFixed(2)),
      score: parseFloat(score.toFixed(1)),
      higherHighs,
      higherLows,
      closeAboveMAs,
      masRising,
      volumeConfirm,
      rsiStrong,
    };

  } catch (error) {
    console.error(`  Error fetching data for ${ticker}:`, error.message);
    return null;
  }
}

// ============================================
// INDICATOR CALCULATIONS
// ============================================

function calculateSMA(bars, period, field = 'c') {
  if (bars.length < period) return bars[bars.length - 1][field];
  const slice = bars.slice(-period);
  const sum = slice.reduce((acc, b) => acc + b[field], 0);
  return sum / period;
}

function calculateRSI(bars, period = 14) {
  if (bars.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < bars.length; i++) {
    changes.push(bars[i].c - bars[i - 1].c);
  }

  const gains = changes.filter(c => c > 0).slice(-period);
  const losses = changes.filter(c => c < 0).slice(-period).map(c => Math.abs(c));

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

function calculateScore(rsi, volumeRatio, price, ma200) {
  const rsiScore = Math.max(0, Math.min(50, (rsi - 50) * 2));
  const volumeScore = Math.max(0, Math.min(20, (volumeRatio - 1) * 20));
  const maDistance = (price - ma200) / ma200 * 100;
  const maScore = Math.max(0, Math.min(30, maDistance * 0.5));

  return rsiScore + volumeScore + maScore;
}

// ============================================
// POSITION MONITORING & EXIT ALERTS
// ============================================

async function monitorExits(allResults) {
  for (const ticker in activePositions) {
    const position = activePositions[ticker];
    const result = allResults.find(r => r.ticker === ticker);
    
    if (!result) continue; // No data for this ticker
    
    const entryPrice = position.entryPrice;
    const currentPrice = result.price;
    const profitTarget = entryPrice * 1.005; // +0.5%
    const stopLoss = entryPrice * 0.995;      // -0.5%
    
    // Check profit target
    if (currentPrice >= profitTarget) {
      const gain = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);
      await sendExitAlert(ticker, 'PROFIT', entryPrice, currentPrice, profitTarget, gain);
      closePosition(ticker);
    }
    // Check stop loss
    else if (currentPrice <= stopLoss) {
      const loss = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);
      await sendExitAlert(ticker, 'LOSS', entryPrice, currentPrice, stopLoss, loss);
      closePosition(ticker);
    }
  }
}

// ============================================
// SLACK ALERTS
// ============================================

async function sendSlackAlert(stock, rank) {
  try {
    const message = {
      text: `🌾 Robot Farmer Alert #${rank}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*🌾 Robot Farmer - Trade Alert #${rank}*\n\n*${stock.ticker}*\n_Composite Score: ${stock.score}/100_\n\n💰 Price: $${stock.price}\n📊 RSI: ${stock.rsi} (Bullish)\n📈 MA50: $${stock.ma50}\n📉 MA200: $${stock.ma200}\n📦 Volume: ${stock.volumeRatio}x average\n\n✅ All Criteria Met:\n • Higher Highs & Lows\n • Price Above Rising MAs\n • Strong Momentum (RSI > 50)\n • Above-Average Volume\n\n💰 **Profit Target: $${(stock.price * 1.005).toFixed(2)} (+0.5%)**\n🛑 **Stop Loss: $${(stock.price * 0.995).toFixed(2)} (-0.5%)**\n\n⏰ ${new Date().toLocaleTimeString()}`
          }
        }
      ]
    };

    await axios.post(SLACK_WEBHOOK, message);
    console.log(`📢 Alert sent: ${stock.ticker} (Score: ${stock.score})`);
  } catch (error) {
    console.error(`❌ Failed to send Slack alert:`, error.message);
  }
}

async function sendExitAlert(ticker, exitType, entryPrice, currentPrice, targetPrice, percentChange) {
  try {
    const emoji = exitType === 'PROFIT' ? '🎯' : '⛔';
    const color = exitType === 'PROFIT' ? '#36a64f' : '#e74c3c';
    
    const message = {
      text: `${emoji} Robot Farmer Exit Alert`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *${exitType === 'PROFIT' ? '🎯 PROFIT TARGET HIT!' : '⛔ STOP LOSS HIT!'}*\n\n*${ticker}*\n\n📍 Entry Price: $${entryPrice.toFixed(2)}\n💵 Current Price: $${currentPrice.toFixed(2)}\n🎯 Target Price: $${targetPrice.toFixed(2)}\n📊 Change: ${percentChange}%\n\n⏰ ${new Date().toLocaleTimeString()}\n\n*ACTION: SELL ${ticker}*`
          }
        }
      ]
    };

    await axios.post(SLACK_WEBHOOK, message);
    console.log(`${emoji} Exit alert sent: ${ticker} - ${exitType}`);
  } catch (error) {
    console.error(`❌ Failed to send exit alert:`, error.message);
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

// ============================================
// MAIN LOOP
// ============================================

console.log(`\n⏱️  Screener will run every 5 minutes during market hours.\n`);

// Run immediately on start
runScreener();

// Then run every 5 minutes
setInterval(runScreener, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(`\n🛑 Robot Farmer shutting down...`);
  process.exit(0);
});

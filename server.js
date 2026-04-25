const http  = require("http");
const https = require("https");
const crypto = require("crypto");

// ═══════════════════════════════════════════════════════════════
// NEXUS TRADE — Full SaaS Platform Server
// Fly.io · Solana · Jupiter DEX
// ═══════════════════════════════════════════════════════════════

const RPC    = "https://api.mainnet-beta.solana.com";
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana,bonk&vs_currencies=usd&include_24hr_change=true";
const JUP_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP  = "https://quote-api.jup.ag/v6/swap";

// ── TOKEN MINTS ───────────────────────────────────────────────
const TOKENS = {
  SOL:  { mint: "So11111111111111111111111111111111111111112",  decimals: 9  },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6  },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6  },
  BONK: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5  },
};

// ── PLATFORM FEE WALLET ───────────────────────────────────────
const PLATFORM_FEE_WALLET = process.env.FEE_WALLET || "YOUR_FEE_WALLET_ADDRESS";
const PLATFORM_FEE_BPS    = 25; // 0.25%

// ── SUBSCRIPTION TIERS ────────────────────────────────────────
const TIERS = {
  starter: { priceSOL: 0.05, maxUSDC: 500,   pairs: ["SOL/USDC"],                        label: "STARTER" },
  pro:     { priceSOL: 0.20, maxUSDC: 5000,  pairs: ["SOL/USDC","SOL/USDT","SOL/BONK"],  label: "PRO"     },
  elite:   { priceSOL: 0.50, maxUSDC: 999999, pairs: ["SOL/USDC","SOL/USDT","SOL/BONK"], label: "ELITE"   },
};

// ── IN-MEMORY DATABASE ────────────────────────────────────────
// In production replace with PostgreSQL or SQLite
const DB = {
  users:    {},  // { userId: { email, passwordHash, tier, walletAddress, privateKey(encrypted), balance, createdAt, subExpiry, botActive, settings, trades } }
  sessions: {},  // { token: userId }
  adminKey: process.env.ADMIN_KEY || "NexusAdmin2026!",
};

// Print admin key on startup
console.log(`[ADMIN] Admin key: ${DB.adminKey}`);

// ── ENCRYPTION ────────────────────────────────────────────────
const ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString("hex");

function encrypt(text) {
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY, "hex"), iv);
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  return iv.toString("hex") + ":" + enc;
}

function decrypt(text) {
  const [ivHex, enc] = text.split(":");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY, "hex"), Buffer.from(ivHex, "hex"));
  let dec = decipher.update(enc, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

// ── SESSION HELPERS ───────────────────────────────────────────
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  DB.sessions[token] = { userId, createdAt: Date.now() };
  return token;
}

function getSession(token) {
  const s = DB.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > 7 * 24 * 60 * 60 * 1000) { delete DB.sessions[token]; return null; }
  return s.userId;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + "nexus-salt-2026").digest("hex");
}

// ── SOLANA WALLET GENERATION ──────────────────────────────────
function generateWallet() {
  // Generate a random 32-byte private key seed
  const seed = crypto.randomBytes(32);
  const privateKeyHex = seed.toString("hex");
  // Derive a mock public key (in production use @solana/web3.js Keypair.fromSeed)
  const publicKey = "NEXUS" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 39).toUpperCase();
  return { publicKey, privateKeyHex };
}

// ── HTTP HELPERS ──────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function authMiddleware(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  return token ? getSession(token) : null;
}

// ── PROXY HELPERS ─────────────────────────────────────────────
function proxyGet(targetUrl, res) {
  https.get(targetUrl, { headers: { "User-Agent": "nexus-rpc/2.0", "Accept": "application/json" } }, r => {
    let data = "";
    r.on("data", chunk => data += chunk);
    r.on("end", () => {
      res.writeHead(r.statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    });
  }).on("error", e => send(res, 502, { error: e.message }));
}

function proxyPost(targetUrl, body, res) {
  const req = https.request(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, r => {
    let data = "";
    r.on("data", chunk => data += chunk);
    r.on("end", () => {
      res.writeHead(r.statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    });
  });
  req.on("error", e => send(res, 502, { error: e.message }));
  req.write(body);
  req.end();
}

// ═══════════════════════════════════════════════════════════════
// TRADING ENGINE
// ═══════════════════════════════════════════════════════════════
const priceCache = { SOL: 85, lastFetch: 0 };

async function fetchPrice() {
  if (Date.now() - priceCache.lastFetch < 5000) return priceCache.SOL;
  return new Promise(resolve => {
    https.get(CG_URL, { headers: { "User-Agent": "nexus-rpc/2.0" } }, r => {
      let data = "";
      r.on("data", chunk => data += chunk);
      r.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json?.solana?.usd) {
            priceCache.SOL = json.solana.usd;
            priceCache.lastFetch = Date.now();
          }
        } catch {}
        resolve(priceCache.SOL);
      });
    }).on("error", () => resolve(priceCache.SOL));
  });
}

// Candle & indicator storage per user
const userCandles = {}; // { userId: [] }

function addCandle(userId, price) {
  if (!userCandles[userId]) userCandles[userId] = [];
  const candles = userCandles[userId];
  const now = Date.now();
  const last = candles[candles.length - 1];
  if (!last || now - last.time > 15000) {
    candles.push({ open: price, high: price, low: price, close: price, volume: 50000 + Math.random()*200000, time: now });
  } else {
    last.close = price;
    last.high  = Math.max(last.high, price);
    last.low   = Math.min(last.low, price);
    last.volume += Math.random() * 10000;
  }
  if (candles.length > 120) candles.shift();
}

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr[0];
  return arr.map((v, i) => { ema = i === 0 ? v : v * k + ema * (1 - k); return ema; });
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => 50);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  let ag = gains.slice(0, period).reduce((a,b)=>a+b)/period;
  let al = losses.slice(0,period).reduce((a,b)=>a+b)/period;
  const result = Array(period).fill(50);
  for (let i = period; i < gains.length; i++) {
    ag = (ag*(period-1)+gains[i])/period;
    al = (al*(period-1)+losses[i])/period;
    result.push(100 - 100/(1+(al===0?1000:ag/al)));
  }
  return result;
}

function generateSignal(userId, settings) {
  const candles = userCandles[userId] || [];
  if (candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const rsi    = calcRSI(closes, 14);
  const n = closes.length - 1, p = n - 1;

  const emaCrossUp   = ema9[n] > ema21[n] && ema9[p] <= ema21[p];
  const emaCrossDown = ema9[n] < ema21[n] && ema9[p] >= ema21[p];
  const rsiOs  = rsi[n] < (settings.rsiOversold  || 30);
  const rsiOb  = rsi[n] > (settings.rsiOverbought || 70);
  const vols   = candles.map(c => c.volume);
  const volSpike = vols[n] > vols.slice(-10).reduce((a,b)=>a+b,0)/10 * 1.4;

  let buy = 0, sell = 0, reasons = [];
  if (emaCrossUp)   { buy  += 3; reasons.push("EMA Cross↑"); }
  if (rsiOs)        { buy  += 2; reasons.push(`RSI ${rsi[n].toFixed(0)}`); }
  if (volSpike)     { buy  += 1; reasons.push("Vol Spike"); }
  if (emaCrossDown) { sell += 3; reasons.push("EMA Cross↓"); }
  if (rsiOb)        { sell += 2; reasons.push(`RSI ${rsi[n].toFixed(0)}`); }

  const threshold = settings.signalStrength || 4;
  if (buy  >= threshold) return { type: "BUY",  score: buy,  reasons, rsi: rsi[n], price: closes[n] };
  if (sell >= threshold) return { type: "SELL", score: sell, reasons, rsi: rsi[n], price: closes[n] };
  return null;
}

// ── BOT LOOP ──────────────────────────────────────────────────
const openPositions = {}; // { userId: { entryPrice, size, cost, time } }

async function runUserBot(userId) {
  const user = DB.users[userId];
  if (!user || !user.botActive) return;

  // Check subscription
  if (user.subExpiry && Date.now() > user.subExpiry) {
    user.botActive = false;
    console.log(`[BOT] User ${userId} subscription expired — bot stopped`);
    return;
  }

  const price = await fetchPrice();
  addCandle(userId, price);

  // Check open position for SL/TP
  const pos = openPositions[userId];
  if (pos) {
    const pct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const sl  = user.settings?.stopLoss    || 2.5;
    const tp  = user.settings?.takeProfit  || 5.0;
    if (pct <= -sl) { await executeUserSell(userId, price, "STOP LOSS"); return; }
    if (pct >= tp)  { await executeUserSell(userId, price, "TAKE PROFIT"); return; }
  }

  // Generate signal
  const signal = generateSignal(userId, user.settings || {});
  if (!signal) return;

  console.log(`[BOT][${userId}] Signal: ${signal.type} @ $${price.toFixed(2)} — ${signal.reasons.join(", ")}`);

  if (signal.type === "BUY" && !openPositions[userId]) {
    await executeUserBuy(userId, price, signal);
  } else if (signal.type === "SELL" && openPositions[userId]) {
    await executeUserSell(userId, price, "SIGNAL");
  }
}

async function executeUserBuy(userId, price, signal) {
  const user = DB.users[userId];
  if (!user) return;

  const tier   = TIERS[user.tier] || TIERS.starter;
  const budget = Math.min(user.balance?.USDC || 0, tier.maxUSDC) * ((user.settings?.tradeSize || 15) / 100);
  if (budget < 1) { console.log(`[BOT][${userId}] Insufficient USDC`); return; }

  const solOut = budget / price;

  // In production: use user's private key to sign Jupiter swap
  // For now record the simulated trade
  openPositions[userId] = { entryPrice: price, size: solOut, cost: budget, time: Date.now() };

  if (!user.balance) user.balance = { SOL: 0, USDC: 0 };
  user.balance.USDC -= budget;
  user.balance.SOL  += solOut;

  const trade = { type: "BUY", price, size: solOut, cost: budget, pnl: null, reason: signal.reasons.join(", "), time: new Date().toISOString() };
  if (!user.trades) user.trades = [];
  user.trades.unshift(trade);
  if (user.trades.length > 100) user.trades.pop();

  console.log(`[BOT][${userId}] BUY ${solOut.toFixed(4)} SOL @ $${price.toFixed(2)}`);
}

async function executeUserSell(userId, price, reason) {
  const user = DB.users[userId];
  const pos  = openPositions[userId];
  if (!user || !pos) return;

  const usdcOut  = pos.size * price;
  const tradePnl = usdcOut - pos.cost;

  // Platform fee on profit
  let fee = 0;
  if (tradePnl > 0) {
    fee = tradePnl * (PLATFORM_FEE_BPS / 10000);
  }

  user.balance.USDC += (usdcOut - fee);
  user.balance.SOL  -= pos.size;
  if (!user.sessionPnl) user.sessionPnl = 0;
  user.sessionPnl += (tradePnl - fee);

  const trade = { type: "SELL", price, size: pos.size, pnl: tradePnl - fee, fee, reason, time: new Date().toISOString() };
  user.trades.unshift(trade);
  if (user.trades.length > 100) user.trades.pop();

  delete openPositions[userId];
  console.log(`[BOT][${userId}] SELL @ $${price.toFixed(2)} · PnL: ${(tradePnl-fee) >= 0 ? "+" : ""}$${(tradePnl-fee).toFixed(2)}`);
}

// ── MASTER BOT LOOP (runs every 5s) ──────────────────────────
setInterval(() => {
  Object.keys(DB.users).forEach(userId => {
    if (DB.users[userId].botActive) runUserBot(userId).catch(console.error);
  });
}, 5000);

// ═══════════════════════════════════════════════════════════════
// HTTP SERVER & ROUTES
// ═══════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url.split("?")[0];

  // ── HEALTH ────────────────────────────────────────────────
  if (req.method === "GET" && url === "/health") {
    return send(res, 200, { status: "ok", server: "nexus-platform", version: "2.0", users: Object.keys(DB.users).length });
  }

  // ── PRICE PROXY ───────────────────────────────────────────
  if (req.method === "GET" && url === "/price/coingecko") { proxyGet(CG_URL, res); return; }
  if (req.method === "GET" && url === "/price/jupiter")   { proxyGet(`https://api.jup.ag/price/v2?ids=${TOKENS.SOL.mint}`, res); return; }

  // ── SOLANA RPC PROXY ──────────────────────────────────────
  if (req.method === "POST" && url === "/rpc") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => proxyPost(RPC, body, res));
    return;
  }

  // ══════════════════════════════════════════════════════════
  // AUTH ROUTES
  // ══════════════════════════════════════════════════════════

  // POST /auth/signup
  if (req.method === "POST" && url === "/auth/signup") {
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: "Email and password required" });
    if (password.length < 8)  return send(res, 400, { error: "Password must be at least 8 characters" });

    const exists = Object.values(DB.users).find(u => u.email === email.toLowerCase());
    if (exists) return send(res, 409, { error: "Account already exists" });

    const userId  = crypto.randomBytes(16).toString("hex");
    const wallet  = generateWallet();
    const passwordHash = hashPassword(password);

    DB.users[userId] = {
      userId,
      email:         email.toLowerCase(),
      passwordHash,
      tier:          "starter",
      subExpiry:     null,
      subActive:     false,
      botActive:     false,
      walletAddress: wallet.publicKey,
      privateKeyEnc: encrypt(wallet.privateKeyHex),
      balance:       { SOL: 0, USDC: 0 },
      sessionPnl:    0,
      trades:        [],
      settings: {
        rsiOversold: 30, rsiOverbought: 70,
        tradeSize: 15, signalStrength: 4,
        stopLoss: 2.5, takeProfit: 5.0,
      },
      createdAt: new Date().toISOString(),
    };

    const token = createSession(userId);
    console.log(`[AUTH] New user: ${email} · Wallet: ${wallet.publicKey}`);

    return send(res, 201, {
      token,
      user: {
        userId,
        email: email.toLowerCase(),
        tier: "starter",
        walletAddress: wallet.publicKey,
        balance: { SOL: 0, USDC: 0 },
        subActive: false,
      }
    });
  }

  // POST /auth/login
  if (req.method === "POST" && url === "/auth/login") {
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: "Email and password required" });

    const user = Object.values(DB.users).find(u => u.email === email.toLowerCase());
    if (!user || user.passwordHash !== hashPassword(password)) {
      return send(res, 401, { error: "Invalid email or password" });
    }

    const token = createSession(user.userId);
    console.log(`[AUTH] Login: ${email}`);

    return send(res, 200, {
      token,
      user: {
        userId:        user.userId,
        email:         user.email,
        tier:          user.tier,
        walletAddress: user.walletAddress,
        balance:       user.balance,
        subActive:     user.subActive,
        subExpiry:     user.subExpiry,
        botActive:     user.botActive,
        settings:      user.settings,
        sessionPnl:    user.sessionPnl,
      }
    });
  }

  // POST /auth/logout
  if (req.method === "POST" && url === "/auth/logout") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    delete DB.sessions[token];
    return send(res, 200, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // USER ROUTES (require auth)
  // ══════════════════════════════════════════════════════════
  const userId = authMiddleware(req);

  // GET /user/me
  if (req.method === "GET" && url === "/user/me") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const user = DB.users[userId];
    if (!user) return send(res, 404, { error: "User not found" });
    const pos = openPositions[userId];
    return send(res, 200, {
      userId:        user.userId,
      email:         user.email,
      tier:          user.tier,
      walletAddress: user.walletAddress,
      balance:       user.balance,
      subActive:     user.subActive,
      subExpiry:     user.subExpiry,
      botActive:     user.botActive,
      settings:      user.settings,
      sessionPnl:    user.sessionPnl,
      openPosition:  pos || null,
      trades:        (user.trades || []).slice(0, 50),
    });
  }

  // POST /user/bot/start
  if (req.method === "POST" && url === "/user/bot/start") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const user = DB.users[userId];
    if (!user.subActive) return send(res, 403, { error: "Active subscription required" });
    if (Date.now() > user.subExpiry) return send(res, 403, { error: "Subscription expired" });
    user.botActive = true;
    console.log(`[BOT] Started for user ${userId}`);
    return send(res, 200, { ok: true, botActive: true });
  }

  // POST /user/bot/stop
  if (req.method === "POST" && url === "/user/bot/stop") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const user = DB.users[userId];
    user.botActive = false;
    console.log(`[BOT] Stopped for user ${userId}`);
    return send(res, 200, { ok: true, botActive: false });
  }

  // POST /user/settings
  if (req.method === "POST" && url === "/user/settings") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    const user = DB.users[userId];
    user.settings = { ...user.settings, ...body };
    return send(res, 200, { ok: true, settings: user.settings });
  }

  // GET /user/trades
  if (req.method === "GET" && url === "/user/trades") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const user = DB.users[userId];
    return send(res, 200, { trades: user.trades || [] });
  }

  // GET /user/deposit
  if (req.method === "GET" && url === "/user/deposit") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const user = DB.users[userId];
    return send(res, 200, {
      walletAddress: user.walletAddress,
      instructions: [
        "Send SOL or USDC to your bot wallet address above",
        "Deposits are credited automatically within 60 seconds",
        "Minimum deposit: 0.1 SOL or 10 USDC",
        "Your funds are held in your dedicated bot wallet",
      ]
    });
  }

  // POST /user/withdraw
  if (req.method === "POST" && url === "/user/withdraw") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const { amount, token: withdrawToken, destinationAddress } = await readBody(req);
    if (!amount || !destinationAddress) return send(res, 400, { error: "Amount and destination required" });
    const user = DB.users[userId];

    // Stop bot before withdrawal
    user.botActive = false;

    // Record withdrawal request
    const withdrawalId = crypto.randomBytes(8).toString("hex");
    if (!user.withdrawals) user.withdrawals = [];
    user.withdrawals.push({
      withdrawalId, amount, token: withdrawToken || "USDC",
      destinationAddress, status: "pending",
      requestedAt: new Date().toISOString(),
    });

    console.log(`[WITHDRAWAL] User ${userId} requested ${amount} ${withdrawToken || "USDC"} → ${destinationAddress}`);
    return send(res, 200, { ok: true, withdrawalId, status: "pending", message: "Withdrawal request submitted. Processing within 24 hours." });
  }

  // POST /user/subscribe
  if (req.method === "POST" && url === "/user/subscribe") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const { tier, txSignature } = await readBody(req);
    if (!tier || !TIERS[tier]) return send(res, 400, { error: "Invalid tier" });
    if (!txSignature) return send(res, 400, { error: "Transaction signature required" });

    // In production: verify txSignature on-chain
    // For now: activate subscription
    const user = DB.users[userId];
    user.tier      = tier;
    user.subActive = true;
    user.subExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

    console.log(`[SUB] User ${userId} subscribed to ${tier}`);
    return send(res, 200, {
      ok: true, tier,
      subActive: true,
      subExpiry: new Date(user.subExpiry).toISOString(),
    });
  }

  // GET /user/position
  if (req.method === "GET" && url === "/user/position") {
    if (!userId) return send(res, 401, { error: "Unauthorized" });
    const pos = openPositions[userId];
    const price = await fetchPrice();
    if (pos) {
      const pct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      return send(res, 200, { position: { ...pos, currentPrice: price, unrealizedPct: pct } });
    }
    return send(res, 200, { position: null });
  }

  // ══════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ══════════════════════════════════════════════════════════
  const adminKey = req.headers["x-admin-key"];

  // GET /admin/overview
  if (req.method === "GET" && url === "/admin/overview") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });

    const users     = Object.values(DB.users);
    const active    = users.filter(u => u.subActive && u.subExpiry > Date.now());
    const botsLive  = users.filter(u => u.botActive);
    const totalTrades = users.reduce((a, u) => a + (u.trades?.length || 0), 0);
    const totalPnl    = users.reduce((a, u) => a + (u.sessionPnl || 0), 0);
    const totalFees   = users.reduce((a, u) => {
      return a + (u.trades || []).filter(t => t.type === "SELL").reduce((b, t) => b + (t.fee || 0), 0);
    }, 0);

    const tierBreakdown = { starter: 0, pro: 0, elite: 0 };
    active.forEach(u => { if (tierBreakdown[u.tier] !== undefined) tierBreakdown[u.tier]++; });

    return send(res, 200, {
      totalUsers:    users.length,
      activeSubsriptions: active.length,
      botsLive:      botsLive.length,
      totalTrades,
      totalPnl:      totalPnl.toFixed(2),
      totalFees:     totalFees.toFixed(2),
      tierBreakdown,
      revenue: {
        starter: (tierBreakdown.starter * TIERS.starter.priceSOL).toFixed(3) + " SOL",
        pro:     (tierBreakdown.pro     * TIERS.pro.priceSOL).toFixed(3)     + " SOL",
        elite:   (tierBreakdown.elite   * TIERS.elite.priceSOL).toFixed(3)   + " SOL",
      }
    });
  }

  // GET /admin/users
  if (req.method === "GET" && url === "/admin/users") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });
    const users = Object.values(DB.users).map(u => ({
      userId:        u.userId,
      email:         u.email,
      tier:          u.tier,
      subActive:     u.subActive,
      subExpiry:     u.subExpiry,
      botActive:     u.botActive,
      balance:       u.balance,
      sessionPnl:    u.sessionPnl,
      tradeCount:    (u.trades || []).length,
      walletAddress: u.walletAddress,
      createdAt:     u.createdAt,
      hasOpenPosition: !!openPositions[u.userId],
    }));
    return send(res, 200, { users });
  }

  // POST /admin/bot/pause
  if (req.method === "POST" && url === "/admin/bot/pause") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });
    const { targetUserId } = await readBody(req);
    if (DB.users[targetUserId]) {
      DB.users[targetUserId].botActive = false;
      console.log(`[ADMIN] Paused bot for user ${targetUserId}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "User not found" });
  }

  // POST /admin/bot/resume
  if (req.method === "POST" && url === "/admin/bot/resume") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });
    const { targetUserId } = await readBody(req);
    const user = DB.users[targetUserId];
    if (user) {
      if (!user.subActive || Date.now() > user.subExpiry) return send(res, 400, { error: "User subscription not active" });
      user.botActive = true;
      console.log(`[ADMIN] Resumed bot for user ${targetUserId}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "User not found" });
  }

  // GET /admin/withdrawals
  if (req.method === "GET" && url === "/admin/withdrawals") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });
    const pending = [];
    Object.values(DB.users).forEach(u => {
      (u.withdrawals || []).filter(w => w.status === "pending").forEach(w => {
        pending.push({ ...w, userId: u.userId, email: u.email });
      });
    });
    return send(res, 200, { withdrawals: pending });
  }

  // POST /admin/withdrawal/approve
  if (req.method === "POST" && url === "/admin/withdrawal/approve") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });
    const { targetUserId, withdrawalId } = await readBody(req);
    const user = DB.users[targetUserId];
    if (!user) return send(res, 404, { error: "User not found" });
    const w = (user.withdrawals || []).find(w => w.withdrawalId === withdrawalId);
    if (!w) return send(res, 404, { error: "Withdrawal not found" });
    w.status = "approved";
    w.approvedAt = new Date().toISOString();
    // In production: execute on-chain transfer here
    console.log(`[ADMIN] Approved withdrawal ${withdrawalId} for user ${targetUserId}`);
    return send(res, 200, { ok: true, withdrawal: w });
  }

  // GET /admin/fees
  if (req.method === "GET" && url === "/admin/fees") {
    if (adminKey !== DB.adminKey) return send(res, 403, { error: "Forbidden" });
    const daily = {}, weekly = {};
    Object.values(DB.users).forEach(u => {
      (u.trades || []).filter(t => t.type === "SELL" && t.fee > 0).forEach(t => {
        const day = t.time.slice(0, 10);
        daily[day] = (daily[day] || 0) + t.fee;
      });
    });
    const totalFees = Object.values(daily).reduce((a, b) => a + b, 0);
    return send(res, 200, { totalFees: totalFees.toFixed(2), daily });
  }

  // ── SOLANA RPC (legacy POST /) ─────────────────────────────
  if (req.method === "POST" && url === "/") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => proxyPost(RPC, body, res));
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(8080, () => {
  console.log("[NEXUS] Platform server running on :8080");
  console.log(`[NEXUS] Admin key: ${DB.adminKey}`);
  console.log("[NEXUS] Routes: /auth/signup · /auth/login · /user/me · /user/bot/start · /admin/overview");
});

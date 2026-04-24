const http = require("http");
const https = require("https");

const RPC     = "https://api.mainnet-beta.solana.com";
const CG_URL  = "https://api.coingecko.com/api/v3/simple/price?ids=solana,bonk&vs_currencies=usd&include_24hr_change=true";
const JUP_URL = "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112";

function proxyGet(targetUrl, res) {
  https.get(targetUrl, { headers: { "User-Agent": "nexus-rpc/1.0" } }, r => {
    res.writeHead(r.statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    r.pipe(res);
  }).on("error", e => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
}

function proxyPost(targetUrl, body, res) {
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  const req = https.request(targetUrl, options, r => {
    res.writeHead(r.statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    r.pipe(res);
  });
  req.on("error", e => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── PRICE ENDPOINTS ──────────────────────────────────────────
  if (req.method === "GET" && req.url === "/price/coingecko") {
    console.log("[PRICE] CoinGecko proxy request");
    proxyGet(CG_URL, res);
    return;
  }

  if (req.method === "GET" && req.url === "/price/jupiter") {
    console.log("[PRICE] Jupiter price proxy request");
    proxyGet(JUP_URL, res);
    return;
  }

  // ── RPC ENDPOINT ─────────────────────────────────────────────
  if (req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      console.log("[RPC] Proxying request to Solana mainnet");
      proxyPost(RPC, body, res);
    });
    return;
  }

  // ── HEALTH CHECK ─────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "nexus-rpc", version: "1.1" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(8080, () => console.log("[NEXUS] RPC + Price proxy running on :8080"));


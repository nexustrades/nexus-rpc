const http = require("http");
const https = require("https");

const RPC = "https://api.mainnet-beta.solana.com";

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405); res.end(); return; }

  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    const proxy = https.request(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, r => {
      res.writeHead(r.statusCode, { "Content-Type": "application/json" });
      r.pipe(res);
    });
    proxy.on("error", e => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    });
    proxy.write(body);
    proxy.end();
  });
});

server.listen(8080, () => console.log("Nexus RPC proxy on :8080"));

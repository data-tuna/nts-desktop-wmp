// Usage: node tools/proxy.mjs <port>
// A CONNECT proxy for testing reconnect without cutting the machine's network.
// Start the app with --proxy-server=http://127.0.0.1:<port> in its browser
// arguments. `curl http://127.0.0.1:<port>/cut?seconds=30` drops every open
// tunnel and refuses new ones for that long. It logs each tunnel's host and
// bytes, with the time, so the log shows when the stream went and came back.
import http from "node:http";
import net from "node:net";

const port = Number(process.argv[2] ?? 8899);
const tunnels = new Set();
let cutUntil = 0;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const server = http.createServer((req, res) => {
  const seconds = Number(new URL(req.url, "http://x").searchParams.get("seconds"));
  if (!req.url.startsWith("/cut") || !(seconds > 0)) return res.writeHead(404).end();
  cutUntil = Date.now() + seconds * 1000;
  log(`CUT for ${seconds} s, dropping ${tunnels.size} tunnel(s)`);
  for (const t of tunnels) t.destroy();
  res.end("cut\n");
  setTimeout(() => log("cut over"), seconds * 1000);
});

server.on("connect", (req, client) => {
  if (Date.now() < cutUntil) return client.destroy();
  const [host, p] = req.url.split(":");
  const upstream = net.connect(Number(p) || 443, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.pipe(client).pipe(upstream);
  });
  const start = Date.now();
  let bytes = 0;
  upstream.on("data", (d) => (bytes += d.length));
  log(`open  ${req.url}`);
  const close = () => {
    if (!tunnels.delete(client)) return;
    upstream.destroy();
    client.destroy();
    log(`close ${req.url} after ${((Date.now() - start) / 1000).toFixed(1)} s, ${bytes} bytes down`);
  };
  tunnels.add(client);
  for (const s of [client, upstream]) s.on("close", close).on("error", close);
});

server.listen(port, "127.0.0.1", () => log(`CONNECT proxy on 127.0.0.1:${port}`));

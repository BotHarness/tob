#!/usr/bin/env node
// This increment has no login/token handling. Health is always anonymous.
const [command, flag, server] = process.argv.slice(2);
try {
  if (command !== "health" || flag !== "--server" || !server || process.argv.length !== 5) throw new Error("USAGE: tob health --server <origin>");
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("INVALID_SERVER_ORIGIN");
  const outputs = [];
  for (const path of ["/healthz", "/readyz"]) {
    const response = await fetch(new URL(path, url), { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("HEALTH_CHECK_FAILED");
    outputs.push(await response.json());
  }
  console.log(JSON.stringify({ health: outputs[0], readiness: outputs[1] }));
} catch {
  console.log(JSON.stringify({ error: { code: "HEALTH_CHECK_FAILED", usage: "tob health --server <origin>" } }));
  process.exitCode = 1;
}

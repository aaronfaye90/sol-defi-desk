// Paid fallback for indexed RPC methods (getTokenLargestAccounts) that free public RPCs now refuse.
// QuickNode x402 pay-per-request: $0.001 USDC per call from a dedicated low-balance wallet (no account, no API key).
// Hard limits: only Solana-mainnet USDC, exactly 1000 base units per call, and a daily call cap.
import fs from "node:fs";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const URL_ = "https://x402.quicknode.com/solana-mainnet";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DAILY_CAP = Number(process.env.QN_DAILY_CAP || 100);
let payFetch = null, day = "", used = 0, initErr = null;

async function init() {
  if (payFetch || initErr) return;
  try {
    const p = process.env.QN_WALLET_FILE;
    if (!p || !fs.existsSync(p)) { initErr = "no QuickNode wallet configured"; return; }
    const k = JSON.parse(fs.readFileSync(p, "utf8"));
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(k.secretKeyBase58));
    const client = new x402Client();
    client.registerPolicy((_v, reqs) => reqs.filter((r) => r.network === MAINNET && r.asset === USDC && String(r.amount) === "1000"));
    client.register("solana:*", new ExactSvmScheme(signer));
    payFetch = wrapFetchWithPayment(fetch, client);
  } catch (e) { initErr = String(e.message || e).slice(0, 120); }
}

export async function qnCall(method, params, { timeoutMs = 15000 } = {}) {
  await init();
  if (!payFetch) throw new Error("paid RPC unavailable: " + initErr);
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; used = 0; }
  if (used >= DAILY_CAP) throw new Error("paid RPC daily cap reached");
  used++;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await payFetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) throw new Error("quicknode " + r.status + " " + JSON.stringify(j?.error || j).slice(0, 100));
    try { fs.appendFileSync(process.env.QN_LOG_FILE || "/tmp/qn_spend.log", `${new Date().toISOString()} ${method} ${params?.[0] ?? ""} 0.001\n`); } catch {}
    return j.result;
  } finally { clearTimeout(t); }
}
export function qnStats() { return { day, used, cap: DAILY_CAP, ready: !!payFetch, initErr }; }

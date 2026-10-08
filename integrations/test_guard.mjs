// Smoke test for pretrade-guard.mjs.
//   node integrations/test_guard.mjs                 -> free checks only (invalid mint, no payer)
//   X402_BUYER_KEY_FILE=wallet.json node integrations/test_guard.mjs paid <mint>
//     -> one real paid $0.005 check from your own wallet ({"secretKeyBase58": "..."}; keep it out of git)
import fs from "node:fs";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { checkBeforeSwap, guardSwap } from "./pretrade-guard.mjs";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
console.log("invalid:", await checkBeforeSwap("not-a-mint", {}));
console.log("no payer:", await checkBeforeSwap(USDC, {}));
if (process.argv[2] === "paid") {
  const keyFile = process.env.X402_BUYER_KEY_FILE;
  if (!keyFile) throw new Error("set X402_BUYER_KEY_FILE to a JSON file with secretKeyBase58");
  const w = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const signer = await createKeyPairSignerFromBytes(base58.decode(w.secretKeyBase58));
  const client = new x402Client();
  client.registerPolicy((_v, reqs) => reqs.filter((r) => r.network === MAINNET && r.asset === USDC && BigInt(r.amount) <= 5_000n));
  client.register("solana:*", new ExactSvmScheme(signer));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const swap = guardSwap(async (a) => ({ swapped: a.outputMint }), { fetchWithPayment });
  try { console.log("guarded swap:", await swap({ outputMint: process.argv[3] })); }
  catch (e) { console.log("guarded swap threw:", e.message); console.log(JSON.stringify(e.verdict?.report)?.slice(0, 800)); }
}

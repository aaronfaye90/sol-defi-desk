// Pay for one token check with x402 on Solana mainnet (USDC). This is the script used for the demo video's paid call.
//   X402_BUYER_KEY_FILE=wallet.json node examples/buyer_solana.mjs "https://95.216.126.169.sslip.io/v1/token-check?mint=<mint>"
// wallet.json = {"secretKeyBase58": "..."} for a low-balance wallet you control. Never commit it.
// The client policy refuses anything other than Solana-mainnet USDC at or below 0.01 USDC.
import fs from "node:fs";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const keyFile = process.env.X402_BUYER_KEY_FILE;
if (!keyFile) throw new Error("set X402_BUYER_KEY_FILE to a JSON file with secretKeyBase58");
const wallet = JSON.parse(fs.readFileSync(keyFile, "utf8"));
const signer = await createKeyPairSignerFromBytes(base58.decode(wallet.secretKeyBase58));
const url = process.argv[2] || "https://95.216.126.169.sslip.io/v1/token-check?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const client = new x402Client();
client.registerPolicy((_v, reqs) => reqs.filter((r) => r.network === MAINNET && r.asset === USDC && BigInt(r.amount) <= 10_000n));
client.register("solana:*", new ExactSvmScheme(signer, process.env.PAYMENT_RPC_URL ? { rpcUrl: process.env.PAYMENT_RPC_URL } : undefined));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log("buyer", signer.address, "->", url);
const res = await fetchWithPayment(url);
console.log("status", res.status);
const pr = res.headers.get("PAYMENT-RESPONSE");
if (pr) console.log("PAYMENT-RESPONSE", JSON.stringify(JSON.parse(Buffer.from(pr, "base64").toString())));
if (res.status === 402) {
  const h = res.headers.get("PAYMENT-REQUIRED");
  if (h) console.log("402", JSON.parse(Buffer.from(h, "base64").toString()).error);
}
const text = await res.text();
console.log(text.slice(0, 4000));
if (!res.ok) process.exit(1);

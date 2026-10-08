// DEVNET test buyer: pays the x402 challenge with devnet USDC and prints the result + settlement receipt.
import fs from "node:fs";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const wallet = JSON.parse(fs.readFileSync(new URL("./buyer-devnet.json", import.meta.url), "utf8"));
const signer = await createKeyPairSignerFromBytes(base58.decode(wallet.secretKeyBase58));
const url = process.argv[2] || "http://127.0.0.1:4021/v1/token-check?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const client = new x402Client();
// Spend policy: devnet USDC only, max 0.01 USDC per request.
client.registerPolicy((_v, reqs) => reqs.filter((r) => r.network === DEVNET && r.asset === USDC_DEVNET && BigInt(r.amount) <= 10_000n));
client.register("solana:*", new ExactSvmScheme(signer, process.env.PAYMENT_RPC_URL ? { rpcUrl: process.env.PAYMENT_RPC_URL } : undefined));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log("buyer", signer.address, "->", url);
const res = await fetchWithPayment(url);
console.log("status", res.status);
const pr = res.headers.get("PAYMENT-RESPONSE");
if (pr) console.log("PAYMENT-RESPONSE", JSON.stringify(JSON.parse(Buffer.from(pr, "base64").toString())));
if (res.status === 402) { const h = res.headers.get("PAYMENT-REQUIRED"); if (h) console.log("402 reason:", JSON.parse(Buffer.from(h, "base64").toString()).error); }
const text = await res.text();
console.log(text.slice(0, 1500));
if (!res.ok) process.exit(1);

// Minimal self-hosted x402 facilitator (verify + settle) for Solana, using the official @x402/svm facilitator scheme.
// Used for local end-to-end tests against a surfpool devnet fork, and optionally for mainnet self-facilitation
// (then FEE_PAYER_KEY must be a dedicated hot wallet holding a little SOL for tx fees - never the vault key).
import express from "express";
import fs from "node:fs";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";

const env = process.env;
const keyFile = env.FEE_PAYER_KEY_FILE;
if (!keyFile) throw new Error("Set FEE_PAYER_KEY_FILE (json with secretKeyBase58)");
const signer = await createKeyPairSignerFromBytes(base58.decode(JSON.parse(fs.readFileSync(keyFile, "utf8")).secretKeyBase58));
const networks = (env.FACILITATOR_NETWORKS || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1").split(",");
const svmSigner = toFacilitatorSvmSigner(signer, { defaultRpcUrl: env.PAYMENT_RPC_URL || "https://api.devnet.solana.com" });

const facilitator = new x402Facilitator();
registerExactSvmScheme(facilitator, { signer: svmSigner, networks });

const app = express();
app.use(express.json({ limit: "256kb" }));
app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
app.post("/verify", async (req, res) => {
  try { res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements)); }
  catch (e) { console.error("verify error", e); res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/settle", async (req, res) => {
  try { const r = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements); console.log("settle", JSON.stringify(r)); res.json(r); }
  catch (e) { console.error("settle error", e); res.status(500).json({ error: String(e.message || e) }); }
});
const port = Number(env.FACILITATOR_PORT || 4022);
app.listen(port, "127.0.0.1", () => console.log(`facilitator on http://127.0.0.1:${port} feePayer=${signer.address} rpc=${env.PAYMENT_RPC_URL} networks=${networks}`));

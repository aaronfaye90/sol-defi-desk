// Generates a DEVNET-ONLY test buyer keypair. Never fund with mainnet assets.
import { generateKeyPairSigner, createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import fs from "node:fs";
const path = new URL("./buyer-devnet.json", import.meta.url).pathname;
if (fs.existsSync(path)) { console.log("exists:", JSON.parse(fs.readFileSync(path)).address); process.exit(0); }
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const priv = pkcs8.slice(-32);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const bytes = new Uint8Array([...priv, ...pub]);
const signer = await createKeyPairSignerFromBytes(bytes);
fs.writeFileSync(path, JSON.stringify({ WARNING: "DEVNET TEST WALLET ONLY - never send mainnet funds", network: "solana-devnet", address: signer.address, secretKeyBase58: base58.encode(bytes) }, null, 2), { mode: 0o600 });
console.log("created:", signer.address);

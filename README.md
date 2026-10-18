# sol-defi-desk

**Check the token before the agent buys it.** Pay-per-call Solana token safety checks for AI agents: half a cent in USDC per check over [x402](https://www.x402.org/), with no account, no API key and no KYC.

- Live: https://95.216.126.169.sslip.io (buyer guide [`/buyer`](https://95.216.126.169.sslip.io/buyer), [`/openapi.json`](https://95.216.126.169.sslip.io/openapi.json), [`/llms.txt`](https://95.216.126.169.sslip.io/llms.txt), public operator ledger [`/ledger`](https://95.216.126.169.sslip.io/ledger))
- Built and operated by **Survivor, an openly AI agent** (not a person). Supervised by a human.
- Submitted to the Colosseum Crypto World's Fair hackathon (Solana track). All code here was written between 2026-09-27 and 2026-10-07; see [`docs/DEVELOPMENT_LOG.md`](docs/DEVELOPMENT_LOG.md).

## Why
Trading agents now buy Solana tokens on their own, and most new tokens are pump.fun launches. Token-risk tools usually need a signup, an API key or a monthly plan, which an agent can't get by itself, so it skips the check. Generic holder-concentration checks also misfire on pump.fun: the bonding-curve account and the Mayhem-mode program vault look like whales. Write-up: [`docs/pumpfun-holder-concentration.md`](docs/pumpfun-holder-concentration.md).

## What a check returns
All values come from direct Solana mainnet account reads:
- token program (SPL / Token-2022), decimals, supply
- mint authority and freeze authority (active or renounced)
- Token-2022 risk extensions: permanent delegate, transfer hook, transfer fee, pausable, non-transferable, default-frozen, mint close authority
- metadata (Metaplex or Token-2022) and whether it can still change
- top-1 / top-10 holder concentration, with pump.fun bonding-curve and Mayhem vaults excluded
- pump.fun curve status (on curve or graduated, quote asset, amount in curve)
- `flags[]` with severities and a heuristic `riskLevel` (`low` | `medium` | `high` | `critical`). Known regulated issuers (USDC, USDT, PYUSD) have issuer controls downgraded to `info`.

It does **not** check DEX liquidity or price. Heuristic signals only; not financial advice.

Example responses: [`docs/examples/free_example_token_check.json`](docs/examples/free_example_token_check.json) (free sample) and [`docs/examples/paid_call_20261007.txt`](docs/examples/paid_call_20261007.txt) (real paid call, with settlement tx).

## Interfaces and prices
| Interface | Endpoint / name | Price |
|---|---|---|
| HTTP + x402 | `GET /v1/token-check?mint=` (alias `/v1/solana-rug-check`) | $0.005 USDC |
| HTTP + x402 | `GET /v1/token-check/batch?mints=a,b,…` (1-5 mints) | $0.01 USDC |
| HTTP + x402 | `GET /v1/lending-reserve?reserve=` (Kamino klend reserve read: available, borrowed, utilization) | $0.005 USDC |
| HTTP, free | `/v1/mint-preflight?mint=`, `/v1/examples/token-check`, `/health`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`, `/.well-known/agent.json` | free |
| MCP (Streamable HTTP) | `POST /mcp`: `token_check`, `token_check_batch` (paid); `mint_preflight`, `describe_paid_api` (free) | same as HTTP |
| Virtuals ACP (Base escrow) | 5 offerings, see [`acp/SETUP.md`](acp/SETUP.md) | $0.01-$0.20 |

Payment rails: Solana USDC and Base USDC (x402 v2 `exact` scheme, PayAI facilitator). Failed lookups (4xx/5xx or a partial read) are never settled, so a buyer never pays for an error.

## Pre-trade guard (drop-in)
[`integrations/pretrade-guard.mjs`](integrations/pretrade-guard.mjs) wraps any swap function so an agent refuses unsafe output tokens:
```js
import { guardSwap } from "./integrations/pretrade-guard.mjs";
const safeSwap = guardSwap(mySwap, { fetchWithPayment, maxRisk: "medium" });
await safeSwap({ outputMint: "<mint>", /* ... */ }); // throws if the token is flagged
```
It runs the free preflight, then the paid check, and blocks on a permanent delegate, non-transferable, default-frozen, pausable, an active freeze authority, or `riskLevel` above your limit. It fails closed by default. Guide: [`integrations/pretrade-guard.md`](integrations/pretrade-guard.md).

## Layout
| Path | What |
|---|---|
| `src/server.mjs` | Express server: x402 paywall (Solana + Base) via `@x402/express`, discovery docs, rate limits |
| `src/tokencheck.mjs` | The check: RPC pool with failover, Metaplex/Token-2022 parsing, pump.fun curve decoding, flags |
| `src/mcp_mount.mjs` | MCP server (free + x402-paid tools) |
| `src/qnrpc.mjs` | Pay-per-request QuickNode RPC fallback for holder lookups ($0.001/call, daily cap) |
| `src/lendingreserve.mjs` | Kamino klend reserve decoder |
| `src/facilitator.mjs` | Optional self-hosted x402 facilitator (used for local e2e tests) |
| `acp/` | Virtuals ACP seller: offering specs + provider loop |
| `integrations/` | Pre-trade guard module, guide and smoke test |
| `examples/buyer_solana.mjs` | Minimal paying client (x402 on Solana) |
| `devnet-test/` | Devnet / local-fork end-to-end payment tests (wallets are generated locally and git-ignored) |
| `deploy/` | env example, systemd unit, VPS install script (Caddy + Let's Encrypt) |
| `docs/` | Buyer guide, pump.fun write-up, example responses, development log |

## Run it
Node 20+.
```bash
npm ci
cp .env.example .env            # set your own PAY_TO / BASE_PAY_TO addresses
node --env-file=.env src/server.mjs
curl -i "http://localhost:4021/v1/token-check?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"   # -> 402 with payment terms
```
Pay for a check from your own low-balance wallet:
```bash
X402_BUYER_KEY_FILE=/path/outside/repo/wallet.json node examples/buyer_solana.mjs "https://95.216.126.169.sslip.io/v1/token-check?mint=<mint>"
```
Devnet end-to-end tests (nothing real moves): `devnet-test/run-e2e-surfnet.sh` (local surfpool fork) or `devnet-test/run-e2e-devnet-hosted.sh`.

## Secrets
No keys, wallet secrets or `.env` files are in this repo. Wallets are read from files named by environment variables (`QN_WALLET_FILE`, `X402_BUYER_KEY_FILE`, devnet test wallets) and those paths are git-ignored. Addresses in the code and env examples (`13TR2nE8…SyM6`, `0xb6c06eB1…C128f7`) are the live service's public receiving addresses.

## License
MIT (see [`LICENSE`](LICENSE)). Built on open-source packages: Coinbase x402 (`@x402/*`), Solana Kit, the MCP TypeScript SDK, Express, viem, zod. Hosted services used: PayAI x402 facilitator, QuickNode x402 RPC, public Solana RPCs, Virtuals ACP.

## Colosseum Crypto World's Fair

Submission kit (videos, paste text, steps): https://95.216.126.169.sslip.io/colosseum/ — see also [COLOSSEUM.md](./COLOSSEUM.md). Deadline Oct 12, 2026 11:59 PM PT.

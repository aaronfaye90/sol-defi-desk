# Development log

This repo was uploaded in one go through GitHub's web uploader, so it has no commit history. This log is the history instead. Dates are Pacific Time. All of this work falls inside the Crypto World's Fair window (2026-09-14 to 2026-10-12); there is no earlier code.

Who did the work: the code was written, tested, deployed and operated by **Survivor**, an autonomous AI agent, supervised by a human (the team leader). Survivor is openly an AI and is not presented as a person. Its own day-by-day work notes and a public money ledger back these dates (ledger: https://95.216.126.169.sslip.io/ledger).

| Date | Version | What shipped |
|---|---|---|
| 2026-09-27 | | Project started. x402 v2 `exact` resource server (Solana USDC) + `tokencheck.mjs` (authorities, Token-2022 extensions, Metaplex metadata, holder concentration, flags). End-to-end paid calls verified on a local surfpool devnet fork with a self-hosted facilitator, then on real devnet. |
| 2026-09-28 | | Soft launch on Solana mainnet (PayAI facilitator); first mainnet settlement was a self-test. |
| 2026-10-01 / 02 | 0.1.1 - 0.1.8 | Moved to a durable host (small VPS, Caddy + Let's Encrypt). Agent discovery: `/llms.txt`, `/.well-known/x402`, agent card, OpenAPI, robots/sitemap. Paid batch SKU (1-5 mints, $0.01). Free `/v1/mint-preflight`, `/client.js`, per-IP rate limits. Streamable HTTP MCP server with free and x402-paid tools. |
| 2026-10-03 | 0.1.11 - 0.1.25 | Listed in the Official MCP Registry. Second payment rail: USDC on Base. CORS for browser/agent clients. `/.well-known/x402.json`. |
| 2026-10-04 | | Kamino klend reserve decoder and paid `/v1/lending-reserve` route. |
| 2026-10-05 / 06 | up to 0.1.29 | Dexter x402 marketplace verifier graded the paid routes as passing. Pay-per-request QuickNode RPC fallback for holder lookups that free RPCs refuse. pump.fun bonding-curve decoding; bonding-curve and Mayhem-mode vaults excluded from holder concentration (write-up in `docs/pumpfun-holder-concentration.md`). First outside paid call (0.005 USDC on Base, 2026-10-06 12:35 AM PT). |
| 2026-10-07 | | Virtuals ACP seller "Survivor Token Check" with five offerings (`acp/`). Free MIT pre-trade guard (`integrations/`). Found and fixed a production permissions bug that kept the paid holder-lookup fallback from loading (wallet file owned by root, service runs as an unprivileged user). |

## Tests that exist
- `devnet-test/run-e2e-surfnet.sh`: full pay -> verify -> settle loop on a local devnet fork (no faucet, nothing real moves).
- `devnet-test/run-e2e-devnet-hosted.sh`: same against real devnet and the public x402.org facilitator.
- `integrations/test_guard.mjs`: free checks of the guard, plus an optional real paid check.
- `acp/provider.mjs` with `DRY_RUN=1 ONCE=1 ACP_EVENTS=fixture_events.jsonl`: replays a fixture ACP job without touching the chain.

# Virtuals ACP seller ("Survivor Token Check")

The same Solana token check, sold as jobs on Virtuals Agent Commerce Protocol (ACP). Buyers fund a USDC escrow on Base; the provider delivers JSON and the escrow releases.

Live agent: https://app.virtuals.io/acp/agents/01a11582-cb0f-7c16-8d31-fdaac51bbf16

## Offerings (specs in this folder)
| Offering | Price | Input | Spec |
|---|---|---|---|
| `solana_token_check` | $0.05 | `{"mint"}` | `offering.json` |
| `solana_token_check_batch` | $0.20 | `{"mints":[1-10]}` | `offering_batch.json` |
| `solana_mint_authority_check` | $0.01 | `{"mint"}` | `offering_mint_authority.json` |
| `solana_holder_concentration` | $0.02 | `{"mint"}` | `offering_holders.json` |
| `pumpfun_curve_status` | $0.01 | `{"mint"}` | `offering_pumpfun.json` |

## How it runs
1. Configure the `acp` CLI with your own agent and signer (`acp configure`, `acp agent create`), then create each offering from its JSON spec, e.g.
   `acp offering create --name solana_token_check --description "$(jq -r .description offering.json)" --price-type fixed --price-value 0.05 --sla-minutes 5 --requirements "$(jq -c .requirements offering.json)" --deliverable "$(jq -r .deliverable offering.json)" --no-required-funds --no-hidden`
2. Run `ACP_CONFIG_DIR=<your config dir> ./run_acp.sh`. It keeps one `acp events listen` process writing `events.jsonl` and runs `provider.mjs`, which drains events every 5 s.
3. `provider.mjs` drives each job: requirement -> set budget -> funded -> run `src/tokencheck.mjs` -> submit the JSON deliverable. It routes by offering name (from `acp job list`), never sets a budget for an invalid mint, and does not submit the holder offering if holder data can't be read.

## Test without spending
`DRY_RUN=1 ONCE=1 ACP_EVENTS=fixture_events.jsonl node provider.mjs` prints the CLI commands it would run for a fixture job.

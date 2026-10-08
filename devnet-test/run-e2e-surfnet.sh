#!/usr/bin/env bash
# End-to-end x402 test on a LOCAL surfpool fork of Solana devnet (no real funds, no faucet needed).
# Flow: buyer (devnet test wallet) -> 402 -> signed USDC-devnet transfer -> local facilitator verify+settle -> 200 + receipt.
set -euo pipefail
cd "$(dirname "$0")/.."
FP=$(python3 -c "import json;print(json.load(open('devnet-test/facilitator-feepayer-devnet.json'))['address'])")
LOGDIR=${LOGDIR:-/tmp/sol-defi-desk-e2e}; mkdir -p "$LOGDIR"
~/.local/bin/surfpool start --network devnet --no-tui --no-studio --no-deploy -y --airdrop "$FP" --port 8899 --ws-port 8900 > "$LOGDIR/surfpool.log" 2>&1 & SP=$!
trap 'kill $SP $FAC $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' localhost:8899 | grep -q result && break; sleep 1; done
devnet-test/surfnet-fund.sh
FEE_PAYER_KEY_FILE=devnet-test/facilitator-feepayer-devnet.json PAYMENT_RPC_URL=http://127.0.0.1:8899 node src/facilitator.mjs > "$LOGDIR/facilitator.log" 2>&1 & FAC=$!
sleep 2
FACILITATOR_URL=http://127.0.0.1:4022 node src/server.mjs > "$LOGDIR/server.log" 2>&1 & SRV=$!
sleep 3
PAYMENT_RPC_URL=http://127.0.0.1:8899 node devnet-test/buyer.mjs "http://127.0.0.1:4021/v1/token-check?mint=${MINT:-DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263}"
devnet-test/surfnet-fund.sh >/dev/null 2>&1 || true

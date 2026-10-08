#!/usr/bin/env bash
# End-to-end on REAL Solana devnet with the public x402.org facilitator.
# Prereq (one-time, needs a browser + captcha, done by a human-operated browser/agent): request devnet USDC at
# https://faucet.circle.com (network: Solana Devnet) to BOTH addresses:
#   - buyer:  $(jq -r .address devnet-test/buyer-devnet.json)   (pays)
#   - payTo:  13TR2nE8wUB5QEV5p4fdpa5UNatwyATfzoKJeZ3FSyM6      (creates its devnet USDC token account; required as the x402 exact scheme does not create it)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=4031 node src/server.mjs > /tmp/sol-defi-desk-devnet-server.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 3
node devnet-test/buyer.mjs "http://127.0.0.1:4031/v1/token-check?mint=${MINT:-DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263}"

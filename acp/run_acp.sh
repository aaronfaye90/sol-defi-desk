#!/bin/bash
# Supervisor for the Virtuals ACP provider. Restarts the event listener and provider if they exit.
# Set these for your own setup (nothing secret lives in this repo):
#   ACP_BIN         path to the `acp` CLI (npm package for Virtuals ACP)
#   ACP_CONFIG_DIR  directory holding your ACP CLI config/signer (created by `acp configure`)
#   QN_WALLET_FILE  optional: JSON file with a low-balance Solana wallet for QuickNode x402 holder lookups
#   QN_LOG_FILE     optional: where paid RPC calls are logged
#   QN_DAILY_CAP    optional: max paid RPC calls per day (default 100)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
export ACP_BIN="${ACP_BIN:-acp}"
export ACP_CONFIG_DIR="${ACP_CONFIG_DIR:?set ACP_CONFIG_DIR to your ACP CLI config dir}"
export QN_LOG_FILE="${QN_LOG_FILE:-$HERE/qn_spend.log}"
export QN_DAILY_CAP="${QN_DAILY_CAP:-100}"
( while true; do "$ACP_BIN" events listen --output "$HERE/events.jsonl" --json >> "$HERE/listener.log" 2>&1; echo "$(date -Is) listener exited, restart" >> "$HERE/listener.log"; sleep 10; done ) &
while true; do node provider.mjs >> provider.log 2>&1; echo "$(date -Is) provider exited, restart" >> provider.log; sleep 10; done

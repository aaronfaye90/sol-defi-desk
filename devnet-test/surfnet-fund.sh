#!/usr/bin/env bash
# LOCAL surfpool (devnet fork) only: give the test buyer 5 devnet-USDC and create the payTo's USDC ATA via surfnet cheatcodes.
set -euo pipefail
RPC=${SURFNET_RPC:-http://127.0.0.1:8899}
USDC=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
TOKEN=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
BUYER=$(python3 -c "import json;print(json.load(open('$(dirname "$0")/buyer-devnet.json'))['address'])")
PAYTO=${PAY_TO:-13TR2nE8wUB5QEV5p4fdpa5UNatwyATfzoKJeZ3FSyM6}
rpc(){ curl -s -X POST -H 'content-type: application/json' -d "$1" "$RPC"; echo; }
rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"surfnet_setTokenAccount\",\"params\":[\"$BUYER\",\"$USDC\",{\"amount\":5000000,\"state\":\"initialized\"},\"$TOKEN\"]}"
rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"surfnet_setTokenAccount\",\"params\":[\"$PAYTO\",\"$USDC\",{\"amount\":0,\"state\":\"initialized\"},\"$TOKEN\"]}"
for o in $BUYER $PAYTO; do rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"getTokenAccountsByOwner\",\"params\":[\"$o\",{\"mint\":\"$USDC\"},{\"encoding\":\"jsonParsed\"}]}" | python3 -c "import json,sys;d=json.load(sys.stdin);[print('$o'[:8],a['pubkey'],a['account']['data']['parsed']['info']['tokenAmount']['uiAmountString']) for a in d['result']['value']]"; done

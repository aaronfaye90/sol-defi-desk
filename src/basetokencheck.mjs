// Base (eip155:8453) ERC-20 pre-trade risk check from direct on-chain reads only.
// Survivor — an autonomous AI agent. Heuristic pre-screen, not financial advice.
import { createPublicClient, http, fallback, toFunctionSelector, getAddress, isAddress, parseAbi, zeroAddress } from "viem";
import { base } from "viem/chains";

const RPCS = (process.env.BASE_DATA_RPC_URLS || "https://mainnet.base.org,https://base-rpc.publicnode.com").split(",");
export const baseClient = createPublicClient({
  chain: base,
  transport: fallback(RPCS.map((u) => http(u.trim(), { timeout: 12_000, retryCount: 1 }))),
  batch: { multicall: true },
});

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const UNI_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
const UNI_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const SLOT_1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SLOT_1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const SLOT_ZOS_IMPL = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"; // FiatTokenProxy / ZeppelinOS
const SLOT_ZOS_ADMIN = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";
// Known regulated / canonical issuers: privileged functions are expected and reported as info.
export const KNOWN_BASE_ISSUERS = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC (Circle)",
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": "EURC (Circle)",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "USDbC (bridged USDC)",
  "0x4200000000000000000000000000000000000006": "WETH (Base canonical)",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC (Coinbase)",
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": "cbETH (Coinbase)",
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT (bridged)",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI (bridged)",
};

const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
]);
const v2f = parseAbi(["function getPair(address,address) view returns (address)"]);
const v3f = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const aerof = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

// Privileged-function signatures to look for in runtime bytecode (PUSH4 selector scan).
const RISKY = [
  { id: "mint_function", severity: "high", why: "owner/role can mint new supply", sigs: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "_mint(address,uint256)"] },
  { id: "blacklist_function", severity: "high", why: "can block specific wallets from selling/transferring", sigs: ["blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "blacklistAddress(address,bool)", "addBlacklist(address)", "setBots(address[])", "setBot(address,bool)", "addBots(address[])", "blockBots(address[])", "setBlacklisted(address,bool)", "updateBlacklist(address,bool)"] },
  { id: "pausable_transfers", severity: "medium", why: "transfers can be paused", sigs: ["pause()", "unpause()"] },
  { id: "fee_setter", severity: "medium", why: "buy/sell tax can be changed after launch", sigs: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxFee(uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setTaxes(uint256,uint256)", "updateFees(uint256,uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "updateBuyFees(uint256,uint256,uint256)", "updateSellFees(uint256,uint256,uint256)", "setFeePercent(uint256)", "setTax(uint256)", "setTaxRates(uint256,uint256)"] },
  { id: "trading_toggle", severity: "medium", why: "owner controls when/if trading is enabled", sigs: ["enableTrading()", "openTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "startTrading()", "tradingStatus(bool)"] },
  { id: "max_tx_limits", severity: "low", why: "owner can set max transaction / wallet limits", sigs: ["setMaxTxAmount(uint256)", "setMaxWalletSize(uint256)", "setMaxTxPercent(uint256)", "updateMaxTxnAmount(uint256)", "updateMaxWalletAmount(uint256)", "setMaxWallet(uint256)", "removeLimits()"] },
  { id: "fee_exclusion", severity: "low", why: "owner can exempt chosen wallets from fees/limits", sigs: ["excludeFromFee(address)", "excludeFromFees(address,bool)", "setExcludeFromFee(address,bool)", "excludeFromMaxTransaction(address,bool)"] },
  { id: "access_control_roles", severity: "info", why: "uses role-based access control (check who holds roles)", sigs: ["grantRole(bytes32,address)"] },
];
const RISKY_SEL = RISKY.map((g) => ({ ...g, sels: g.sigs.map((s) => toFunctionSelector(`function ${s}`).slice(2).toLowerCase()) }));

function hasPush4(codeHex, sel) { return codeHex.includes("63" + sel); }
function slotAddr(v) { if (!v || /^0x0*$/.test(v)) return null; const a = "0x" + v.slice(-40); return a === zeroAddress ? null : getAddress(a); }
async function safe(p) { try { return await p; } catch { return undefined; } }

export function isValidEvmAddress(a) { return typeof a === "string" && isAddress(a, { strict: false }); }

export async function baseTokenCheck(addrIn) {
  const c = baseClient;
  const token = getAddress(addrIn);
  const code = await c.getCode({ address: token });
  if (!code || code === "0x") return { ok: false, status: 404, error: "not_a_contract", hint: "address has no contract code on Base mainnet" };
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    safe(c.readContract({ address: token, abi: erc20, functionName: "name" })),
    safe(c.readContract({ address: token, abi: erc20, functionName: "symbol" })),
    safe(c.readContract({ address: token, abi: erc20, functionName: "decimals" })),
    safe(c.readContract({ address: token, abi: erc20, functionName: "totalSupply" })),
  ]);
  if (decimals === undefined || totalSupply === undefined) return { ok: false, status: 400, error: "not_erc20", hint: "contract does not answer decimals()/totalSupply()" };

  // Proxy detection
  const [implSlot, adminSlot, beaconSlot, zosImpl, zosAdmin] = await Promise.all([
    safe(c.getStorageAt({ address: token, slot: SLOT_1967_IMPL })),
    safe(c.getStorageAt({ address: token, slot: SLOT_1967_ADMIN })),
    safe(c.getStorageAt({ address: token, slot: SLOT_1967_BEACON })),
    safe(c.getStorageAt({ address: token, slot: SLOT_ZOS_IMPL })),
    safe(c.getStorageAt({ address: token, slot: SLOT_ZOS_ADMIN })),
  ]);
  let implementation = slotAddr(implSlot);
  let proxyAdmin = slotAddr(adminSlot);
  const beacon = slotAddr(beaconSlot);
  let proxyKind = implementation ? "eip1967" : null;
  if (!implementation && slotAddr(zosImpl)) { implementation = slotAddr(zosImpl); proxyAdmin = slotAddr(zosAdmin); proxyKind = "zeppelinos-fiattoken"; }
  if (!implementation && beacon) { implementation = await safe(c.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation" })); proxyKind = "eip1967-beacon"; }
  const lc = code.toLowerCase();
  if (!implementation && lc.startsWith("0x363d3d373d3d3d363d73")) { implementation = getAddress("0x" + lc.slice(22, 62)); proxyKind = "eip1167-minimal"; }
  let scanCode = lc;
  if (implementation) { const ic = await safe(c.getCode({ address: implementation })); if (ic && ic !== "0x") scanCode = lc + ic.toLowerCase(); }

  // Ownership
  const ownerA = await safe(c.readContract({ address: token, abi: erc20, functionName: "owner" }));
  const ownerB = ownerA === undefined ? await safe(c.readContract({ address: token, abi: erc20, functionName: "getOwner" })) : undefined;
  const owner = ownerA ?? ownerB ?? null;
  const renounced = owner != null && (owner === zeroAddress || owner.toLowerCase() === DEAD.toLowerCase());
  const ownerActive = owner != null && !renounced;

  // Balances of notable holders (no indexer: owner, dead, token contract itself)
  const pct = (b) => (totalSupply > 0n && b != null ? Number((b * 1000000n) / totalSupply) / 10000 : null);
  const [ownerBal, deadBal, selfBal] = await Promise.all([
    ownerActive ? safe(c.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [owner] })) : Promise.resolve(null),
    safe(c.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [DEAD] })),
    safe(c.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [token] })),
  ]);

  // Liquidity: Uniswap v2, Uniswap v3 (4 fee tiers), Aerodrome (volatile+stable) vs WETH and USDC
  const pools = [];
  const quotes = token.toLowerCase() === WETH.toLowerCase() ? [USDC] : token.toLowerCase() === USDC.toLowerCase() ? [WETH] : [WETH, USDC];
  const lookups = [];
  for (const q of quotes) {
    lookups.push(safe(c.readContract({ address: UNI_V2_FACTORY, abi: v2f, functionName: "getPair", args: [token, q] })).then((p) => ({ dex: "uniswap-v2", quote: q, pool: p })));
    for (const fee of [100, 500, 3000, 10000]) lookups.push(safe(c.readContract({ address: UNI_V3_FACTORY, abi: v3f, functionName: "getPool", args: [token, q, fee] })).then((p) => ({ dex: `uniswap-v3-${fee}`, quote: q, pool: p })));
    for (const st of [false, true]) lookups.push(safe(c.readContract({ address: AERO_FACTORY, abi: aerof, functionName: "getPool", args: [token, q, st] })).then((p) => ({ dex: st ? "aerodrome-stable" : "aerodrome-volatile", quote: q, pool: p })));
  }
  const found = (await Promise.all(lookups)).filter((x) => x.pool && x.pool !== zeroAddress);
  await Promise.all(found.map(async (f) => {
    const [qBal, tBal] = await Promise.all([
      safe(c.readContract({ address: f.quote, abi: erc20, functionName: "balanceOf", args: [f.pool] })),
      safe(c.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [f.pool] })),
    ]);
    const entry = { dex: f.dex, pool: f.pool, quote: f.quote.toLowerCase() === WETH.toLowerCase() ? "WETH" : "USDC" };
    entry.quoteReserve = qBal == null ? null : (f.quote.toLowerCase() === WETH.toLowerCase() ? Number(qBal) / 1e18 : Number(qBal) / 1e6);
    entry.tokenReservePct = pct(tBal);
    if (f.dex === "uniswap-v2" || f.dex.startsWith("aerodrome")) {
      const [lpSupply, lpDead, lpZero] = await Promise.all([
        safe(c.readContract({ address: f.pool, abi: erc20, functionName: "totalSupply" })),
        safe(c.readContract({ address: f.pool, abi: erc20, functionName: "balanceOf", args: [DEAD] })),
        safe(c.readContract({ address: f.pool, abi: erc20, functionName: "balanceOf", args: [zeroAddress] })),
      ]);
      if (lpSupply && lpSupply > 0n) entry.lpBurnedPct = Number((((lpDead || 0n) + (lpZero || 0n)) * 1000000n) / lpSupply) / 10000;
    }
    pools.push(entry);
  }));
  pools.sort((a, b) => (b.quote === "WETH" ? (b.quoteReserve || 0) * 2500 : (b.quoteReserve || 0)) - (a.quote === "WETH" ? (a.quoteReserve || 0) * 2500 : (a.quoteReserve || 0)));
  const liqWeth = pools.filter((p) => p.quote === "WETH").reduce((s, p) => s + (p.quoteReserve || 0), 0);
  const liqUsdc = pools.filter((p) => p.quote === "USDC").reduce((s, p) => s + (p.quoteReserve || 0), 0);

  // Flags
  const flags = [];
  const fnFound = [];
  const knownIssuer = KNOWN_BASE_ISSUERS[token.toLowerCase()] || null;
  for (const g of RISKY_SEL) {
    const hits = g.sigs.filter((_, i) => hasPush4(scanCode, g.sels[i]));
    if (!hits.length) continue;
    fnFound.push({ id: g.id, functions: hits });
    let sev = g.severity;
    let note = "";
    if (knownIssuer) { sev = "info"; note = ` (known issuer: ${knownIssuer}; expected for this asset)`; }
    else if (renounced && sev !== "info") { sev = sev === "high" ? "low" : "info"; note = " (owner renounced; only matters if another role can call it)"; }
    else if (owner == null && sev === "high") { sev = "medium"; note = " (no owner(); who can call it is not determinable from reads, e.g. a minter role or emissions contract)"; }
    flags.push({ id: g.id, severity: sev, detail: `${g.why}: ${hits.join(", ")}${note}` });
  }
  if (implementation) flags.push({ id: "upgradeable_proxy", severity: knownIssuer ? "info" : "medium", detail: `${proxyKind} proxy; logic can be replaced by the admin${proxyAdmin ? ` (${proxyAdmin})` : ""}. Implementation ${implementation}` });
  if (ownerActive) flags.push({ id: "owner_active", severity: knownIssuer ? "info" : "low", detail: `owner() is ${owner} (not renounced)` });
  const ownerPct = pct(ownerBal);
  if (ownerPct != null && ownerPct >= 5) flags.push({ id: "owner_holds_supply", severity: ownerPct >= 20 ? "high" : "medium", detail: `owner wallet holds ${ownerPct}% of supply` });
  if (!pools.length) flags.push({ id: "no_major_dex_pool", severity: "high", detail: "no Uniswap v2/v3 or Aerodrome pool vs WETH/USDC found (Uniswap v4 and other DEXes not checked)" });
  else if (liqWeth < 0.05 && liqUsdc < 100) flags.push({ id: "no_effective_liquidity", severity: "high", detail: `pools exist but hold only ~${liqWeth.toFixed(6)} WETH + ${liqUsdc.toFixed(2)} USDC on the quote side; selling would be near-impossible` });
  else if (liqWeth < 1 && liqUsdc < 2500) flags.push({ id: "thin_liquidity", severity: "medium", detail: `quote-side liquidity ~${liqWeth.toFixed(3)} WETH + ${liqUsdc.toFixed(0)} USDC across pools found` });
  const v2like = pools.filter((p) => p.lpBurnedPct != null);
  if (v2like.length && v2like.every((p) => p.lpBurnedPct < 50) && !pools.some((p) => p.dex.startsWith("uniswap-v3"))) flags.push({ id: "lp_not_burned", severity: "medium", detail: `v2-style LP tokens mostly not burned (max burned ${Math.max(...v2like.map((p) => p.lpBurnedPct))}%); liquidity can be pulled unless locked elsewhere` });

  const sevs = flags.map((f) => f.severity);
  const riskLevel = sevs.includes("high") ? "high" : sevs.filter((s) => s === "medium").length >= 2 ? "medium" : sevs.includes("medium") ? "medium" : "low";

  return {
    ok: true,
    body: {
      chain: "base", chainId: 8453, token, knownIssuer,
      name: name ?? null, symbol: symbol ?? null, decimals: Number(decimals), totalSupply: totalSupply.toString(),
      owner, ownerRenounced: owner == null ? null : renounced, ownerHoldsPct: ownerPct,
      deadAddressHoldsPct: pct(deadBal), contractHoldsPct: pct(selfBal),
      proxy: implementation ? { kind: proxyKind, implementation, admin: proxyAdmin } : null,
      privilegedFunctions: fnFound,
      liquidity: { pools, totalQuoteWeth: Number(liqWeth.toFixed(6)), totalQuoteUsdc: Number(liqUsdc.toFixed(2)), note: "Uniswap v2/v3 + Aerodrome vs WETH/USDC only; Uniswap v4 not checked" },
      riskLevel, flags,
      notChecked: ["sell simulation (honeypot)", "actual buy/sell tax rate", "full holder distribution", "source verification"],
      method: "Direct Base mainnet eth_call/getCode/getStorageAt reads + runtime-bytecode selector scan. Heuristic only; not financial advice.",
      operator: "Survivor - an autonomous AI agent (not a human)",
      generatedAt: new Date().toISOString(),
    },
  };
}

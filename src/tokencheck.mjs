// On-chain-only Solana token safety check.
// All facts come from public Solana account state via JSON-RPC (no third-party data resold).
import { getProgramDerivedAddress, getAddressEncoder, address as toAddress } from "@solana/kit";
import { qnCall } from "./qnrpc.mjs";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PUMPFUN_INITIAL_REAL_TOKENS = 793100000000000n; // tokens sellable on a standard pump.fun curve (6 decimals)
const MAYHEM_PROGRAM = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"; // pump.fun Mayhem program (pump-public-docs COIN_CREATION.md)
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const KNOWN_QUOTES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 } };
function b58(buf) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + (buf.toString("hex") || "0")), out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = "1" + out; }
  return out;
}

// pump.fun bonding curve status from its on-chain account (PDA ["bonding-curve", mint]). Null if the mint has no curve.
async function pumpfunCurve(rpc, mint, tokenProgram) {
  const enc = getAddressEncoder();
  const [bc] = await getProgramDerivedAddress({ programAddress: toAddress(PUMPFUN_PROGRAM), seeds: ["bonding-curve", enc.encode(toAddress(mint))] });
  const r = await rpc.call("getAccountInfo", [bc, { encoding: "base64", commitment: "confirmed" }], { timeoutMs: 5000, retries: 2 });
  const v = r?.value;
  if (!v || v.owner !== PUMPFUN_PROGRAM) return null;
  const d = Buffer.from(v.data[0], "base64");
  if (d.length < 49) return null;
  const realTok = d.readBigUInt64LE(24), realQuote = d.readBigUInt64LE(32), complete = d[48] === 1;
  // Trailing fields appended by later upgrades (pump-public-docs PUMP_PROGRAM_README.md / idl/pump.json BondingCurve);
  // shorter, older accounts read missing fields as false / default pubkey.
  const mayhemMode = d.length > 81 ? d[81] === 1 : false;
  const quoteMintRaw = d.length >= 115 ? b58(d.subarray(83, 115)) : DEFAULT_PUBKEY;
  const quoteMint = quoteMintRaw === DEFAULT_PUBKEY ? null : quoteMintRaw;
  const holderReward = d.length > 124 ? d[124] === 1 : false;
  const [curveAta] = await getProgramDerivedAddress({ programAddress: toAddress(ATA_PROGRAM), seeds: [enc.encode(toAddress(bc)), enc.encode(toAddress(tokenProgram)), enc.encode(toAddress(mint))] });
  let mayhemTokenVault = null, mayhemVaultRaw = null;
  if (mayhemMode) {
    const [solVault] = await getProgramDerivedAddress({ programAddress: toAddress(MAYHEM_PROGRAM), seeds: ["sol-vault"] });
    [mayhemTokenVault] = await getProgramDerivedAddress({ programAddress: toAddress(ATA_PROGRAM), seeds: [enc.encode(toAddress(solVault)), enc.encode(toAddress(tokenProgram)), enc.encode(toAddress(mint))] });
    try { const tb = await rpc.call("getAccountInfo", [mayhemTokenVault, { encoding: "jsonParsed", commitment: "confirmed" }], { timeoutMs: 5000, retries: 2 }); mayhemVaultRaw = tb?.value?.data?.parsed?.info?.tokenAmount?.amount ?? null; } catch { mayhemVaultRaw = null; }
  }
  // Mayhem coins use different curve parameters, so percent-sold against the standard 793.1M is not meaningful for them.
  const progress = complete ? 100 : mayhemMode ? null : realTok <= PUMPFUN_INITIAL_REAL_TOKENS ? Math.round(Number(((PUMPFUN_INITIAL_REAL_TOKENS - realTok) * 10000n) / PUMPFUN_INITIAL_REAL_TOKENS)) / 100 : null;
  const q = quoteMint ? KNOWN_QUOTES[quoteMint] || null : { symbol: "SOL", decimals: 9 };
  const quoteInCurve = complete ? 0 : q ? Math.round((Number(realQuote) / 10 ** q.decimals) * 1000) / 1000 : null;
  return {
    platform: "pump.fun",
    bondingCurve: bc,
    curveTokenAccount: curveAta,
    graduated: complete,
    quoteAsset: q ? q.symbol : quoteMint,
    quoteMint,
    solInCurve: quoteMint ? null : quoteInCurve,
    quoteInCurve,
    quoteInCurveRaw: complete ? "0" : realQuote.toString(),
    curveProgressPct: progress,
    mayhemMode,
    mayhemTokenVault,
    mayhemVaultTokensRaw: mayhemVaultRaw,
    holderRewardCoin: holderReward,
    note: complete ? "Bonding curve completed; trading moved to a DEX pool (DEX liquidity not checked)" : "Still trading on the pump.fun bonding curve, not yet on a DEX" + (mayhemMode ? "; mayhem-mode coin, so curve figures are not comparable to standard coins" : ""),
  };
}
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Well-known issuer-controlled assets: active mint/freeze authority is expected for these.
export const KNOWN_ISSUER_ASSETS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC (Circle)",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT (Tether)",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD (Paxos)",
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: "USDS (Sky)",
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: "EURC (Circle)",
};

export function isValidMint(s) {
  return typeof s === "string" && BASE58_RE.test(s);
}

export class RpcPool {
  constructor(urls, { timeoutMs = 8000, minRetries = 3 } = {}) {
    this.urls = urls.filter(Boolean);
    this.timeoutMs = timeoutMs;
    this.i = 0;
  }
  async call(method, params, { timeoutMs = this.timeoutMs, retries = Math.max(3, this.urls.length * 2) } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const url = this.urls[(this.i + attempt) % this.urls.length];
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const j = await r.json().catch(() => ({}));
        if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code });
        if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
        this.i = (this.i + attempt) % this.urls.length;
        return j.result;
      } catch (e) {
        lastErr = e;
        // Method disabled/blocked by this provider: retrying will not help.
        if (e.code === -32602 || /blocked|not supported|disabled|not allowed/i.test(e.message)) {
          if (this.urls.length === 1) throw e; else continue;
        }
        const rateLimited = e.code === -32005 || e.code === 429 || /rate limit|429/i.test(e.message);
        await new Promise((res) => setTimeout(res, (rateLimited ? 1000 : 250) * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}

function readBorshString(buf, off) {
  const len = buf.readUInt32LE(off);
  const s = buf.subarray(off + 4, off + 4 + len).toString("utf8").replace(/\0+$/g, "").trim();
  return [s, off + 4 + len];
}

export function parseMetaplexMetadata(buf) {
  let o = 1; // key
  const updateAuthority = bs58encode(buf.subarray(o, o + 32)); o += 32;
  o += 32; // mint
  let name, symbol, uri;
  [name, o] = readBorshString(buf, o);
  [symbol, o] = readBorshString(buf, o);
  [uri, o] = readBorshString(buf, o);
  o += 2; // seller fee bps
  const hasCreators = buf[o]; o += 1;
  if (hasCreators === 1) { const n = buf.readUInt32LE(o); o += 4 + n * 34; }
  o += 1; // primary sale happened
  const isMutable = buf[o] === 1;
  return { name, symbol, uri, updateAuthority, isMutable };
}

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

const holderCache = new Map();
const holderRaw = new Map(); // mint -> [{address, amount}] from the last getTokenLargestAccounts (same lifetime as holderCache)
const la_cache_has = (mint) => holderRaw.has(mint);
let holdersBlockedUntil = 0; // skip the holder query for 10 min after the provider refuses it

export async function tokenCheck(rpc, mint) {
  const acct = await rpc.call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const slot = acct?.context?.slot ?? null;
  const v = acct?.value;
  if (!v) return { ok: false, status: 404, error: "account_not_found", mint };
  const program = v.owner;
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return { ok: false, status: 422, error: "not_a_token_mint", mint, owner: program };
  const parsed = v.data?.parsed;
  if (parsed?.type !== "mint") return { ok: false, status: 422, error: "not_a_token_mint", mint, parsedType: parsed?.type };
  const info = parsed.info;
  const decimals = info.decimals;
  const supplyRaw = BigInt(info.supply);
  const exts = Object.fromEntries((info.extensions || []).map((e) => [e.extension, e.state ?? true]));

  // Metadata: Token-2022 metadata extension, else Metaplex metadata PDA.
  let metadata = null;
  if (exts.tokenMetadata) {
    const m = exts.tokenMetadata;
    metadata = { source: "token-2022-extension", name: m.name, symbol: m.symbol, uri: m.uri, updateAuthority: m.updateAuthority ?? null, isMutable: !!m.updateAuthority };
  } else {
    try {
      const enc = getAddressEncoder();
      const [pda] = await getProgramDerivedAddress({
        programAddress: toAddress(METAPLEX_METADATA),
        seeds: ["metadata", enc.encode(toAddress(METAPLEX_METADATA)), enc.encode(toAddress(mint))],
      });
      const md = await rpc.call("getAccountInfo", [pda, { encoding: "base64", commitment: "confirmed" }]);
      if (md?.value?.data?.[0]) metadata = { source: "metaplex", ...parseMetaplexMetadata(Buffer.from(md.value.data[0], "base64")) };
      else metadata = { source: "none" };
    } catch (e) {
      // Upstream failure: fail the request (HTTP 503) so the buyer is NOT charged for an incomplete answer.
      throw new Error("metadata lookup failed: " + String(e.message || e).slice(0, 120));
    }
  }

  // Holder concentration (some public RPCs block this method; reported as unavailable then).
  // Free RPC first; most public RPCs now refuse this indexed method, so fall back to a paid QuickNode call ($0.001).
  let holders = null;
  const hc = holderCache.get(mint);
  if (hc && Date.now() - hc.t < 600000) holders = hc.h;
  else {
    let la = null, src = null, errs = [];
    if (Date.now() >= holdersBlockedUntil) {
      try { la = await rpc.call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], { timeoutMs: 5000, retries: 1 }); src = "free-public-rpc"; }
      catch (e) { if (e.code === -32602 || /blocked|429|too many|personal token/i.test(e.message)) holdersBlockedUntil = Date.now() + 600000; errs.push(String(e.message || e).slice(0, 80)); }
    }
    if (!la) {
      try { la = await qnCall("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]); src = "quicknode"; }
      catch (e) { errs.push(String(e.message || e).slice(0, 80)); }
    }
    if (la) {
      const vals = (la?.value || []).map((a) => BigInt(a.amount));
      if (supplyRaw > 0n) {
        const pct = (x) => Number((x * 1000000n) / supplyRaw) / 10000;
        holders = { top1Pct: vals[0] !== undefined ? pct(vals[0]) : null, top10Pct: pct(vals.slice(0, 10).reduce((a, b) => a + b, 0n)), accountsSampled: vals.length, rpc: src, note: "token accounts (can include pools/exchanges/burn), not unique owners" };
        holderCache.set(mint, { t: Date.now(), h: holders }); holderRaw.set(mint, (la?.value || []).map((a) => ({ address: a.address, amount: a.amount })));
        if (holderCache.size > 5000) { holderCache.clear(); holderRaw.clear(); }
      }
    } else holders = { unavailable: true, reason: errs.join("; ").slice(0, 160) || "holder query unavailable" };
  }

  // pump.fun launchpad status (non-fatal: reported as unavailable on RPC failure).
  let launchpad = null;
  try { launchpad = await pumpfunCurve(rpc, mint, program); }
  catch (e) { launchpad = { platform: "pump.fun", unavailable: true, reason: String(e.message || e).slice(0, 100) }; }
  // While a token is on its bonding curve, the curve's own token account is usually the largest holder; it is not a person.
  if (launchpad?.curveTokenAccount && !launchpad.graduated && holders && !holders.unavailable && la_cache_has(mint)) {
    const raw = holderRaw.get(mint);
    const amt = (addr) => BigInt(raw.find((a) => a.address === addr)?.amount ?? 0);
    const rest = raw.filter((a) => a.address !== launchpad.curveTokenAccount && a.address !== launchpad.mayhemTokenVault).map((a) => BigInt(a.amount));
    if (rest.length < raw.length && supplyRaw > 0n) {
      const pct = (x) => Number((x * 1000000n) / supplyRaw) / 10000;
      holders = { ...holders, bondingCurvePct: pct(amt(launchpad.curveTokenAccount)), ...(launchpad.mayhemTokenVault ? { mayhemVaultPct: pct(amt(launchpad.mayhemTokenVault)) } : {}), top1PctExCurve: rest[0] !== undefined ? pct(rest[0]) : null, top10PctExCurve: pct(rest.slice(0, 10).reduce((a, b) => a + b, 0n)) };
    }
  }
  const t1 = holders?.top1PctExCurve ?? holders?.top1Pct, t10 = holders?.top10PctExCurve ?? holders?.top10Pct;

  const known = KNOWN_ISSUER_ASSETS[mint] || null;
  // For known regulated issuers, issuer controls are expected; they are still listed (severity "info").
  const flags = [];
  const add = (id, severity, detail) => flags.push({ id, severity, detail });
  if (info.mintAuthority) add("mint_authority_active", known ? "info" : "high", "Supply can still be increased by " + info.mintAuthority);
  if (info.freezeAuthority) add("freeze_authority_active", known ? "info" : "high", "Holder token accounts can be frozen by " + info.freezeAuthority);
  if (exts.permanentDelegate?.delegate) add("permanent_delegate", known ? "info" : "critical", "Delegate can move/burn anyone's tokens: " + exts.permanentDelegate.delegate);
  if (exts.transferHook?.programId) add("transfer_hook", known ? "info" : "high", "Every transfer invokes program " + exts.transferHook.programId);
  if (exts.transferFeeConfig) { const bps = exts.transferFeeConfig.newerTransferFee?.transferFeeBasisPoints ?? exts.transferFeeConfig.olderTransferFee?.transferFeeBasisPoints; add("transfer_fee", bps > 100 ? "high" : bps > 0 ? "medium" : "info", `Transfer fee currently ${bps} bps (fee authority can change it)`); }
  if (exts.nonTransferable) add("non_transferable", "critical", "Token cannot be transferred");
  if (exts.defaultAccountState?.accountState === "frozen") add("default_frozen", "high", "New token accounts start frozen");
  if (exts.pausableConfig) add("pausable", known ? "info" : "high", "Transfers can be paused by " + (exts.pausableConfig.authority || "authority"));
  if (exts.mintCloseAuthority?.closeAuthority) add("mint_close_authority", known ? "info" : "medium", "Mint can be closed by " + exts.mintCloseAuthority.closeAuthority);
  if (exts.confidentialTransferMint) add("confidential_transfers", "info", "Confidential transfer extension present");
  if (metadata?.isMutable) add("metadata_mutable", "low", "Name/symbol/URI can be changed by " + metadata.updateAuthority);
  if (!metadata || metadata.source === "none") add("no_metadata", "low", "No on-chain name/symbol found");
  if (supplyRaw === 0n) add("zero_supply", "medium", "Supply is 0");
  const exNote = holders?.top1PctExCurve !== undefined ? (holders?.mayhemVaultPct !== undefined ? " (excluding the pump.fun bonding curve and Mayhem program vault)" : " (excluding the pump.fun bonding curve)") : "";
  if (t1 > 20 && !known) add("concentrated_top1", "medium", `Largest token account holds ${t1}%${exNote}`);
  if (t10 > 60 && !known) add("concentrated_top10", "medium", `Top 10 token accounts hold ${t10}%${exNote}`);
  if (launchpad && !launchpad.unavailable) {
    const lp = launchpad;
    if (lp.graduated) add("pumpfun_graduated", "info", "pump.fun bonding curve completed; now trades on a DEX pool");
    else if (lp.quoteInCurve === null) add("pumpfun_custom_quote", "medium", `Still on the pump.fun bonding curve, paired against an unrecognised quote mint ${lp.quoteMint} ; curve depth not valued`);
    else if (lp.quoteAsset === "SOL" ? lp.quoteInCurve < 5 : lp.quoteAsset === "USDC" ? lp.quoteInCurve < 750 : false) add("thin_bonding_curve", "medium", `Still on the pump.fun bonding curve with only ${lp.quoteInCurve} ${lp.quoteAsset} in it${lp.curveProgressPct !== null ? ` (${lp.curveProgressPct}% sold)` : ""}; very thin market`);
    else add("pumpfun_bonding_curve", "low", `Still on the pump.fun bonding curve: ${lp.quoteInCurve} ${lp.quoteAsset} in it${lp.curveProgressPct !== null ? `, ${lp.curveProgressPct}% sold` : ""}`);
    const mvPct = holders?.mayhemVaultPct ?? (lp.mayhemVaultTokensRaw && supplyRaw > 0n ? Number((BigInt(lp.mayhemVaultTokensRaw) * 1000000n) / supplyRaw) / 10000 : undefined);
    if (lp.mayhemMode) add("pumpfun_mayhem_mode", "low", `pump.fun mayhem-mode coin: pump.fun's Mayhem program holds ${mvPct ?? "an unknown share"}${mvPct !== undefined ? "%" : ""} of supply in vault ${lp.mayhemTokenVault}; curve percent-sold and reserves are not comparable to standard coins`);
    if (lp.holderRewardCoin) add("pumpfun_holder_rewards", "info", "pump.fun holder-rewards coin: creator fees go to holders instead of a creator wallet");
  }

  const rank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const worst = flags.reduce((m, f) => Math.max(m, rank[f.severity]), 0);
  const risk = ["low", "low", "medium", "high", "critical"][worst];

  return {
    ok: true,
    status: 200,
    body: {
      mint,
      slot,
      tokenProgram: program === TOKEN_2022_PROGRAM ? "token-2022" : "spl-token",
      decimals,
      supply: { raw: supplyRaw.toString(), ui: Number(supplyRaw) / 10 ** decimals },
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      token2022Extensions: Object.keys(exts),
      metadata,
      holders,
      launchpad,
      knownIssuerAsset: known,
      riskLevel: risk,
      flags,
      method: "Direct Solana mainnet account reads (getAccountInfo, getTokenLargestAccounts via a public RPC or QuickNode, pump.fun bonding-curve account decoded per pump.fun's public IDL). Heuristic only; not financial advice.",
      generatedAt: new Date().toISOString(),
      operator: "Survivor - an autonomous AI agent (not a human)",
    },
  };
}

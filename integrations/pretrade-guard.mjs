// pretrade-guard.mjs — block a Solana swap when the token looks unsafe.
// MIT. Operated by Survivor, an openly AI agent (not a human). Not financial advice.
//
// Uses sol-defi-desk: free mint preflight, then a paid live check
// ($0.005 USDC via x402 on Solana or Base). You bring your own x402 payer.
//
//   import { checkBeforeSwap, guardSwap } from "./pretrade-guard.mjs";
//   const verdict = await checkBeforeSwap(mint, { fetchWithPayment });
//   if (!verdict.allow) throw new Error(verdict.reason);

const DEFAULT_BASE = "https://95.216.126.169.sslip.io";
const RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * @param {string} mint  base58 SPL / Token-2022 mint
 * @param {object} opts
 * @param {typeof fetch} opts.fetchWithPayment  an x402-wrapped fetch (e.g. @x402/fetch wrapFetchWithPayment)
 * @param {"low"|"medium"|"high"|"critical"} [opts.maxRisk="medium"]  highest riskLevel still allowed
 * @param {string[]} [opts.blockFlags]  flag ids that always block (default: the ones that can take funds or stop sells)
 * @param {boolean} [opts.failOpen=false]  allow the trade if the check itself errors
 * @param {string} [opts.baseUrl]
 */
export async function checkBeforeSwap(mint, opts = {}) {
  const {
    fetchWithPayment,
    maxRisk = "medium",
    blockFlags = ["permanent_delegate", "non_transferable", "default_frozen", "pausable", "freeze_authority_active"],
    failOpen = false,
    baseUrl = DEFAULT_BASE,
  } = opts;
  const fail = (reason) => ({ allow: failOpen, reason, mint, report: null });

  // 1) Free shape check: no payment, catches typos and bad input.
  try {
    const pre = await fetch(`${baseUrl}/v1/mint-preflight?mint=${encodeURIComponent(mint)}`);
    if (pre.status === 400) return { allow: false, reason: "not a valid Solana mint address", mint, report: null };
  } catch (e) {
    return fail(`preflight unreachable: ${e.message}`);
  }
  if (typeof fetchWithPayment !== "function") return fail("no x402 payer configured (fetchWithPayment)");

  // 2) Paid live check. Failed lookups (4xx/5xx) are not settled.
  let report;
  try {
    const res = await fetchWithPayment(`${baseUrl}/v1/token-check?mint=${encodeURIComponent(mint)}`);
    if (!res.ok) return fail(`token check HTTP ${res.status}`);
    report = await res.json();
  } catch (e) {
    return fail(`token check failed: ${e.message}`);
  }

  const hits = (report.flags || []).filter(
    (f) => blockFlags.includes(f.id) && f.severity !== "info" // "info" = known issuer like USDC
  );
  if (hits.length) return { allow: false, reason: `blocked flag(s): ${hits.map((f) => f.id).join(", ")}`, mint, report };
  if ((RANK[report.riskLevel] ?? 4) > RANK[maxRisk]) {
    return { allow: false, reason: `riskLevel ${report.riskLevel} is above ${maxRisk}`, mint, report };
  }
  return { allow: true, reason: `riskLevel ${report.riskLevel}`, mint, report };
}

/**
 * Wrap any swap function so it refuses unsafe output tokens.
 * swapFn(args) must take an object; outputMintKey names the field holding the mint you're buying.
 */
export function guardSwap(swapFn, opts = {}, outputMintKey = "outputMint") {
  return async (args) => {
    const verdict = await checkBeforeSwap(args[outputMintKey], opts);
    if (!verdict.allow) {
      const err = new Error(`swap blocked by pre-trade check: ${verdict.reason}`);
      err.verdict = verdict;
      throw err;
    }
    return swapFn(args);
  };
}

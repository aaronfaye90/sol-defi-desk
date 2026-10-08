#!/usr/bin/env node
// Survivor ACP provider loop for the "solana_token_check" offering (Virtuals Agent Commerce Protocol).
// Reads events written by ONE `acp events listen --output $EVENTS --json` process, drains them every few seconds,
// and drives each job: requirement -> set-budget -> funded -> run tokenCheck -> submit JSON deliverable.
// Openly AI. Never sets a budget for an invalid mint (job just expires; client is never charged).
//
// Env: ACP_BIN (default "acp"), ACP_EVENTS (default ./events.jsonl), ACP_STATE (default ./jobs-state.json),
//      ACP_LOG (default ./jobs.log), ACP_PRICE (default from offering.json), DATA_RPC_URLS, DRY_RUN=1 (print commands only),
//      ONCE=1 (single drain pass, for tests).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const { tokenCheck, RpcPool, isValidMint } = await import(process.env.TOKENCHECK_MODULE || path.join(here, "../src/tokencheck.mjs"));
const run = promisify(execFile);
const offering = JSON.parse(fs.readFileSync(path.join(here, "offering.json"), "utf8"));
const ACP = process.env.ACP_BIN || "acp";
const EVENTS = process.env.ACP_EVENTS || path.join(here, "events.jsonl");
const STATE = process.env.ACP_STATE || path.join(here, "jobs-state.json");
const LOG = process.env.ACP_LOG || path.join(here, "jobs.log");
const PRICE = String(process.env.ACP_PRICE || offering.priceValue);
// Batch offering (added 2026-10-07): {"mints":[...up to 10]} for one flat price. Only priced as batch when the job came
// from the batch offering (job description == its name) or the requirement has "mints" and no "mint" (the single
// offering's schema requires "mint"), so a single-offering client is never charged the batch price.
const batchOffering = fs.existsSync(path.join(here, "offering_batch.json")) ? JSON.parse(fs.readFileSync(path.join(here, "offering_batch.json"), "utf8")) : null;
const BATCH_PRICE = batchOffering ? String(batchOffering.priceValue) : null;
const BATCH_MAX = 10;
// Narrow single-mint offerings (added 2026-10-07): same {"mint"} requirement, cheaper, deliver a subset of the full check.
// Routed by the job's description (= offering name, set by the client SDK) read from `acp job list`.
const AUTH_FLAGS = new Set(["mint_authority_active", "freeze_authority_active", "permanent_delegate", "transfer_hook", "transfer_fee", "non_transferable", "default_frozen", "pausable", "mint_close_authority", "confidential_transfers", "metadata_mutable", "no_metadata", "zero_supply"]);
const pick = (b) => ({ generatedAt: b.generatedAt, operator: b.operator, method: b.method, fullReport: "solana_token_check ($0.05) has every field incl. overall riskLevel" });
export const NARROW = {
  solana_mint_authority_check: { file: "offering_mint_authority.json", project: (b) => ({ mint: b.mint, tokenProgram: b.tokenProgram, decimals: b.decimals, supply: b.supply, mintAuthority: b.mintAuthority, freezeAuthority: b.freezeAuthority, token2022Extensions: b.token2022Extensions, metadataMutable: b.metadata?.isMutable ?? null, metadataUpdateAuthority: b.metadata?.updateAuthority ?? null, authoritiesRenounced: !b.mintAuthority && !b.freezeAuthority, flags: (b.flags || []).filter((f) => AUTH_FLAGS.has(f.id)), ...pick(b) }) },
  solana_holder_concentration: { file: "offering_holders.json", needsHolders: true, project: (b) => ({ mint: b.mint, decimals: b.decimals, supply: b.supply, holders: b.holders, flags: (b.flags || []).filter((f) => f.id.startsWith("concentrated_")), ...pick(b) }) },
  pumpfun_curve_status: { file: "offering_pumpfun.json", project: (b) => ({ mint: b.mint, onPumpfunCurve: !!(b.launchpad && !b.launchpad.unavailable && b.launchpad.platform === "pump.fun"), launchpad: b.launchpad, flags: (b.flags || []).filter((f) => f.id.startsWith("pumpfun_") || f.id === "thin_bonding_curve"), ...pick(b) }) },
};
for (const [n, o] of Object.entries(NARROW)) { const f = path.join(here, o.file); o.price = fs.existsSync(f) ? String(JSON.parse(fs.readFileSync(f, "utf8")).priceValue) : null; if (!o.price) delete NARROW[n]; }
const MIN_SINGLE_PRICE = String(Math.min(Number(PRICE), ...Object.values(NARROW).map((o) => Number(o.price))));
let jobListCache = { t: 0, jobs: [] };
async function jobDescription(jobId) {
  if (process.env.ACP_JOBLIST_FILE) { const js = JSON.parse(fs.readFileSync(process.env.ACP_JOBLIST_FILE, "utf8")).jobs || []; return js.find((x) => String(x.onChainJobId) === jobId)?.description ?? null; }
  if (DRY) return null;
  if (Date.now() - jobListCache.t > 4000) { const r = await acp(["job", "list"]); jobListCache = { t: Date.now(), jobs: r.jobs || r.data?.jobs || [] }; }
  return jobListCache.jobs.find((x) => String(x.onChainJobId) === jobId)?.description ?? null;
}
const DRY = process.env.DRY_RUN === "1";
const rpc = new RpcPool((process.env.DATA_RPC_URLS || "https://solana-rpc.publicnode.com").split(","));

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

async function acp(args) {
  if (DRY) { console.log("[dry]", ACP, args.join(" ")); return { success: true, dry: true }; }
  const { stdout } = await run(ACP, [...args, "--json"], { timeout: 120000, maxBuffer: 8 << 20 });
  try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
}

// Batch: pull a list of mints from {"mints":[...]} (also accepts {"tokens"|"addresses"}). Returns null if absent.
export function extractMints(content) {
  let v = content;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== "object") return null;
  const arr = Array.isArray(v) ? v : (v.mints ?? v.tokens ?? v.addresses);
  if (!Array.isArray(arr)) return null;
  return [...new Set(arr.filter((x) => typeof x === "string").map((x) => x.trim()))];
}

// Pull a mint out of the requirement payload: {"mint": "..."} preferred; also accept {"token"|"address"|"tokenAddress"} or a bare string.
export function extractMint(content) {
  let v = content;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* bare string */ } }
  if (typeof v === "string") { const m = v.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/); return m ? m[0] : null; }
  if (v && typeof v === "object") {
    for (const k of ["mint", "token", "address", "tokenAddress", "token_address", "mintAddress"]) if (typeof v[k] === "string") return v[k].trim();
  }
  return null;
}

async function handle(ev) {
  const jobId = String(ev.jobId ?? ev.entry?.jobId ?? "");
  if (!jobId) return;
  const chainId = String(ev.chainId ?? ev.entry?.chainId ?? "8453");
  const tools = ev.availableTools || [];
  const j = (state[jobId] ||= { chainId, created: new Date().toISOString() });
  const entry = ev.entry || {};
  if (entry.contentType === "requirement" || entry.kind === "message" && entry.contentType === "requirement") {
    j.mint = extractMint(entry.content);
    j.requirementRaw = String(entry.content).slice(0, 500);
    const ms = extractMints(entry.content);
    if (BATCH_PRICE && ms && !j.mint) { j.batch = true; j.mints = ms; j.mint = ms[0] ?? null; } // "mints" with no single "mint"
  }
  const desc = ev.description ?? ev.job?.description ?? entry.event?.description;
  if (desc && batchOffering && desc === batchOffering.name) j.batchOffering = true;
  // Fallback: requirement can be inside the job.created event
  if (!j.mint && entry.event?.requirement) j.mint = extractMint(entry.event.requirement);

  if (tools.includes("setBudget") && !j.budgetSet && j.offering === undefined && !j.batch) {
    try { j.offering = await jobDescription(jobId); } catch (e) { log({ jobId, action: "joblist_error", err: String(e.message || e) }); }
    if (!j.offering) { j.lookupTries = (j.lookupTries || 0) + 1; if (j.lookupTries < 6) { j.offering = undefined; save(); pending.add(jobId); return; } j.offering = null; log({ jobId, action: "offering_unknown_fallback_min_price", price: MIN_SINGLE_PRICE }); }
  }
  const narrow = j.offering ? NARROW[j.offering] : null;
  if (tools.includes("setBudget") && !j.budgetSet && j.mint !== undefined) {
    if (j.batch) {
      const bad = j.mints.filter((m) => !isValidMint(m));
      if (!j.mints.length || j.mints.length > BATCH_MAX || bad.length) {
        if (!j.toldInvalid && tools.includes("sendMessage")) {
          await acp(["message", "send", "--job-id", jobId, "--chain-id", chainId, "--content",
            `Send {"mints":["<base58 mint>", ...]} with 1-${BATCH_MAX} valid Solana mint addresses.` + (bad.length ? ` Invalid: ${bad.slice(0, 3).join(", ")}.` : "") + " No budget was set, so you are not charged."]);
          j.toldInvalid = true; log({ jobId, action: "invalid_batch", raw: j.requirementRaw });
        }
      } else {
        const r = await acp(["provider", "set-budget", "--job-id", jobId, "--amount", BATCH_PRICE, "--chain-id", chainId]);
        j.budgetSet = true; j.amount = BATCH_PRICE; log({ jobId, action: "set_budget", amount: BATCH_PRICE, mints: j.mints, r });
      }
    } else if (!j.mint || !isValidMint(j.mint)) {
      if (!j.toldInvalid && tools.includes("sendMessage")) {
        await acp(["message", "send", "--job-id", jobId, "--chain-id", chainId, "--content",
          'No valid Solana mint found. Send {"mint":"<base58 mint address>"}. No budget was set, so you are not charged.']);
        j.toldInvalid = true; log({ jobId, action: "invalid_mint", raw: j.requirementRaw });
      }
    } else {
      // Price: the offering the client chose; if it could not be identified, the cheapest single-mint price (never overcharge).
      const price = narrow ? narrow.price : j.offering === null ? MIN_SINGLE_PRICE : PRICE;
      const r = await acp(["provider", "set-budget", "--job-id", jobId, "--amount", price, "--chain-id", chainId]);
      j.budgetSet = true; j.amount = price; log({ jobId, action: "set_budget", amount: price, offering: j.offering, mint: j.mint, r });
    }
  }
  if (tools.includes("submit") && !j.submitted && j.batch && j.mints?.length) {
    const results = [];
    for (const m of j.mints) {
      let r;
      try { r = await tokenCheck(rpc, m); } catch (e) { r = { ok: false, body: { error: String(e.message || e) } }; }
      if (!r.ok) { await new Promise((s) => setTimeout(s, 3000)); try { r = await tokenCheck(rpc, m); } catch (e) { r = { ok: false, body: { error: String(e.message || e) } }; } }
      results.push(r.ok ? r.body : { mint: m, error: "check_failed", detail: r.body });
    }
    if (results.every((x) => x.error)) { log({ jobId, action: "batch_failed_not_submitted", mints: j.mints }); save(); return; }
    const deliverable = { count: results.length, results, generatedAt: new Date().toISOString(), operator: "Survivor - an autonomous AI agent (not a human). Heuristic, not financial advice." };
    const s = await acp(["provider", "submit", "--job-id", jobId, "--chain-id", chainId, "--deliverable", JSON.stringify(deliverable)]);
    j.submitted = true; log({ jobId, action: "submit_batch", mints: j.mints, levels: results.map((x) => x.riskLevel ?? "error"), r: s });
  }
  if (tools.includes("submit") && !j.submitted && !j.batch && j.mint) {
    let r;
    try { r = await tokenCheck(rpc, j.mint); } catch (e) { r = { ok: false, status: 503, body: { error: String(e.message || e) } }; }
    if (!r.ok) { // one retry after a short wait; RPC hiccups are the usual cause
      await new Promise((s) => setTimeout(s, 4000));
      try { r = await tokenCheck(rpc, j.mint); } catch (e) { r = { ok: false, body: { error: String(e.message || e) } }; }
    }
    if (r.ok && narrow?.needsHolders && (!r.body.holders || r.body.holders.unavailable)) { log({ jobId, action: "holders_unavailable_not_submitted", mint: j.mint, detail: r.body.holders }); save(); return; }
    const deliverable = r.ok ? (narrow ? narrow.project(r.body) : r.body) : { mint: j.mint, error: "check_failed", detail: r.body, operator: "Survivor - an autonomous AI agent (not a human)" };
    if (!r.ok) { log({ jobId, action: "check_failed_not_submitted", mint: j.mint, detail: r.body }); save(); return; } // don't submit junk; retry next drain
    const s = await acp(["provider", "submit", "--job-id", jobId, "--chain-id", chainId, "--deliverable", JSON.stringify(deliverable)]);
    j.submitted = true; j.riskLevel = r.body.riskLevel; log({ jobId, action: "submit", offering: j.offering, mint: j.mint, riskLevel: r.body.riskLevel, r: s });
  }
  if (["completed", "rejected", "expired"].includes(ev.status) && !j.final) {
    j.final = ev.status; log({ jobId, action: "final", status: ev.status, reason: entry.event?.reason, amount: j.amount || PRICE, mint: j.mint, mints: j.mints });
  }
  save();
}

const pending = new Set(); // jobIds waiting for their offering lookup
const lastEv = new Map();
async function drainOnce() {
  for (const id of [...pending]) { pending.delete(id); const ev = lastEv.get(id); if (ev) { try { await handle(ev); } catch (e) { log({ action: "error", jobId: id, err: String(e.message || e) }); } } }
  if (!fs.existsSync(EVENTS)) return 0;
  let events;
  if (DRY) { events = fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  else { const d = await acp(["events", "drain", "--file", EVENTS, "--limit", "20"]); events = d.events || []; }
  for (const ev of events) { if (ev.jobId) lastEv.set(String(ev.jobId), ev); try { await handle(ev); } catch (e) { log({ action: "error", jobId: ev.jobId, err: String(e.message || e) }); } }
  return events.length;
}

if (process.env.ONCE === "1") { console.log("processed", await drainOnce()); }
else { for (;;) { await drainOnce().catch((e) => log({ action: "drain_error", err: String(e.message || e) })); await new Promise((s) => setTimeout(s, 5000)); } }

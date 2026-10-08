// Paid Kamino klend reserve read. Chain state only (getAccountInfo). No HTTP APIs, no getProgramAccounts.
// Layout: programs/klend/src/state/reserve.rs (zero_copy #[repr(C)] Reserve + ReserveLiquidity),
// fetched from Kamino-Finance/klend master on 2026-10-04, plus the 8-byte Anchor account discriminator.
// Probe note research/lending_reserve_probe_20261004.md: owner KLend…, data length 8624
// (8 + published Reserve size 8616), lending_market at byte 32, liquidity mint at byte 128.
import { base58 } from "@scure/base";
import { isValidMint } from "./tokencheck.mjs";

export const KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
// 8-byte discriminator + Reserve size 8616. Any other length is unsupported; do not guess.
export const KAMINO_RESERVE_DATA_LEN = 8624;

// Absolute offsets into the account (discriminator included).
const OFF_LENDING_MARKET = 32;
const OFF_LIQUIDITY = 128;
const OFF_MINT = OFF_LIQUIDITY + 0; // ReserveLiquidity.mint_pubkey
const OFF_AVAILABLE = OFF_LIQUIDITY + 96; // after mint, supply_vault, fee_vault
const OFF_BORROWED_SF = OFF_LIQUIDITY + 104; // borrowed_amount_sf: u128
const OFF_DECIMALS = OFF_LIQUIDITY + 144; // mint_decimals: u64
// BigFractionBytes is [u64; 4] + padding [u64; 2] = 48 bytes, starting at liquidity+168.
const OFF_PROTOCOL_FEES_SF = OFF_LIQUIDITY + 216;
const OFF_REFERRER_FEES_SF = OFF_LIQUIDITY + 232;
const OFF_PENDING_FEES_SF = OFF_LIQUIDITY + 248;

// programs/klend/src/utils/fraction.rs: `pub use fixed::types::U68F60 as Fraction`.
const FRAC_NBITS = 60n;

function readU64(buf, off) {
  return buf.readBigUInt64LE(off);
}

function readU128(buf, off) {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) + lo;
}

function pubkeyAt(buf, off) {
  return base58.encode(buf.subarray(off, off + 32));
}

/**
 * utilization = borrowed / total_supply
 * total_supply = available + borrowed - protocol_fees - referrer_fees - pending_referrer_fees
 * Source: ReserveLiquidity::utilization_rate and ReserveLiquidity::total_supply
 * in programs/klend/src/state/reserve.rs.
 * Integer token amounts become Fraction via from(u64) = value << 60.
 * *_sf fields are already Fraction bits (from_bits). Source returns 0 when total_supply is 0.
 * No APY: borrow_rate_curve.get_borrow_rate is not applied here.
 */
export function utilizationRatio(available, borrowedSf, protocolSf, referrerSf, pendingSf) {
  const availableSf = available << FRAC_NBITS;
  const feesSf = protocolSf + referrerSf + pendingSf;
  const grossSf = availableSf + borrowedSf;
  if (feesSf > grossSf) {
    return { utilization: null, totalSupplySf: null, reason: "fee_fields_exceed_supply" };
  }
  const totalSupplySf = grossSf - feesSf;
  if (totalSupplySf === 0n) {
    return { utilization: "0", totalSupplySf: "0", reason: null };
  }
  const scale = 10n ** 12n;
  const q = (borrowedSf * scale) / totalSupplySf;
  const whole = q / scale;
  const frac = (q % scale).toString().padStart(12, "0");
  return { utilization: `${whole}.${frac}`, totalSupplySf: totalSupplySf.toString(), reason: null };
}

export function decodeKaminoReserve(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== KAMINO_RESERVE_DATA_LEN) {
    return {
      ok: false,
      error: "unsupported_reserve",
      detail: "account data length is not the published Kamino Reserve size",
      dataLength: buf?.length ?? null,
      expectedDataLength: KAMINO_RESERVE_DATA_LEN,
    };
  }
  const available = readU64(buf, OFF_AVAILABLE);
  const borrowedSf = readU128(buf, OFF_BORROWED_SF);
  const protocolSf = readU128(buf, OFF_PROTOCOL_FEES_SF);
  const referrerSf = readU128(buf, OFF_REFERRER_FEES_SF);
  const pendingSf = readU128(buf, OFF_PENDING_FEES_SF);
  const decimals = readU64(buf, OFF_DECIMALS);
  const util = utilizationRatio(available, borrowedSf, protocolSf, referrerSf, pendingSf);
  return {
    ok: true,
    lendingMarket: pubkeyAt(buf, OFF_LENDING_MARKET),
    mint: pubkeyAt(buf, OFF_MINT),
    mintDecimals: decimals <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decimals) : decimals.toString(),
    availableAmount: available.toString(),
    borrowedAmount: (borrowedSf >> FRAC_NBITS).toString(),
    borrowedAmountSf: borrowedSf.toString(),
    protocolFeesSf: protocolSf.toString(),
    referrerFeesSf: referrerSf.toString(),
    pendingReferrerFeesSf: pendingSf.toString(),
    totalSupplySf: util.totalSupplySf,
    utilization: util.utilization,
    utilizationOmittedReason: util.reason,
  };
}

export function isValidReserveAddress(s) {
  return isValidMint(s);
}

export async function lendingReserveRead(rpc, reserve) {
  const acct = await rpc.call("getAccountInfo", [reserve, { encoding: "base64", commitment: "confirmed" }]);
  const slot = acct?.context?.slot ?? null;
  const v = acct?.value;
  if (!v) return { ok: false, status: 404, error: "account_not_found", reserve };
  const owner = v.owner;
  const raw = v.data?.[0];
  const len = raw ? Buffer.from(raw, "base64").length : 0;
  if (owner !== KLEND_PROGRAM || len !== KAMINO_RESERVE_DATA_LEN) {
    return {
      ok: false,
      status: 422,
      error: "unsupported_reserve",
      reserve,
      owner,
      dataLength: len,
      expectedOwner: KLEND_PROGRAM,
      expectedDataLength: KAMINO_RESERVE_DATA_LEN,
      detail: "Only the published Kamino klend Reserve layout (owner + data length) is decoded. Other programs are not guessed.",
    };
  }
  const decoded = decodeKaminoReserve(Buffer.from(raw, "base64"));
  if (!decoded.ok) {
    return { ok: false, status: 422, reserve, owner, ...decoded };
  }
  return {
    ok: true,
    status: 200,
    body: {
      reserve,
      mint: decoded.mint,
      lendingMarket: decoded.lendingMarket,
      mintDecimals: decoded.mintDecimals,
      availableAmount: decoded.availableAmount,
      borrowedAmount: decoded.borrowedAmount,
      borrowedAmountSf: decoded.borrowedAmountSf,
      utilization: decoded.utilization,
      utilizationInputs: {
        availableAmount: decoded.availableAmount,
        borrowedAmountSf: decoded.borrowedAmountSf,
        protocolFeesSf: decoded.protocolFeesSf,
        referrerFeesSf: decoded.referrerFeesSf,
        pendingReferrerFeesSf: decoded.pendingReferrerFeesSf,
        totalSupplySf: decoded.totalSupplySf,
        omittedReason: decoded.utilizationOmittedReason,
        // programs/klend/src/state/reserve.rs ReserveLiquidity::total_supply / utilization_rate
        // programs/klend/src/utils/fraction.rs Fraction = U68F60 (integer << 60)
        scale: "U68F60",
      },
      slot,
      owner,
      dataLength: len,
      apy: null,
      method: "Direct Solana mainnet getAccountInfo of one Kamino klend reserve. Utilization from the published ReserveLiquidity formula. No APY. Not financial advice.",
      generatedAt: new Date().toISOString(),
      operator: "Survivor - an autonomous AI agent (not a human)",
    },
  };
}

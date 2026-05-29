/**
 * Dry-run: compare designGraphCurve minimum supply vs 1B fixed supply.
 * Run: npx tsx scripts/verify_config_supply.ts
 */
import { BN } from "@coral-xyz/anchor";
import { designGraphCurve, getTotalSupplyFromCurve } from "../tests/utils/create_curve";

const lockedVesting = {
  amountPerPeriod: new BN(0),
  cliffDurationFromMigrationTime: new BN(0),
  frequency: new BN(0),
  numberOfPeriod: new BN(0),
  cliffUnlockAmount: new BN(0),
};
const baseFee = {
  cliffFeeNumerator: new BN(10_000_000),
  firstFactor: 0,
  secondFactor: new BN(0),
  thirdFactor: new BN(0),
  baseFeeMode: 0,
};

const p = designGraphCurve(
  1_000_000_000,
  6_250,
  195_312_500,
  1,
  6,
  9,
  50,
  0,
  lockedVesting,
  10_000,
  1.1,
  baseFee
);

const pre = new BN(1_000_000_000).mul(new BN(10 ** 6));
const left = new BN(10_000).mul(new BN(10 ** 6));
const minWithLeft = getTotalSupplyFromCurve(
  p.migrationQuoteThreshold,
  p.sqrtStartPrice,
  p.curve,
  lockedVesting,
  1,
  left,
  0
);
const minNoLeft = getTotalSupplyFromCurve(
  p.migrationQuoteThreshold,
  p.sqrtStartPrice,
  p.curve,
  lockedVesting,
  1,
  new BN(0),
  0
);

console.log("migrationQuoteThreshold COOK", Number(p.migrationQuoteThreshold) / 1e9);
console.log("pre/post supply (human)", Number(pre) / 1e6);
console.log("min required with leftover (human)", Number(minWithLeft) / 1e6);
console.log("min required no leftover (human)", Number(minNoLeft) / 1e6);
console.log("passes fixed 1B?", minNoLeft.lte(pre) && minWithLeft.lte(pre));
console.log("curve points", p.curve.length);

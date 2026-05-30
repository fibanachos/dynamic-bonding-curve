/**
 * Dry-verify every preset in create_config.ts builds without throwing.
 * Run: npx tsx scripts/verify_all_presets.ts
 */
import BN from "bn.js";
import { designCurve, designGraphCurve } from "../tests/utils/create_curve";

const lockedVesting = {
  amountPerPeriod: new BN(0),
  cliffDurationFromMigrationTime: new BN(0),
  frequency: new BN(0),
  numberOfPeriod: new BN(0),
  cliffUnlockAmount: new BN(0),
};
const migrationFee = { feePercentage: 0, creatorFeePercentage: 0 };
const baseFee = {
  baseFeeMode: 0,
  cliffFeeNumerator: new BN(10_000_000),
  firstFactor: 0,
  secondFactor: new BN(0),
  thirdFactor: new BN(0),
};

type GraphPreset = { method: "graph"; init: number; mig: number; k: number; leftOver: number };
type CurvePreset = { method: "curve"; pct: number };
const PRESETS: Record<number, GraphPreset | CurvePreset> = {
  1_000_000: { method: "graph", init: 300_000, mig: 5_153_211, k: 1.0, leftOver: 1_000 },
  200_000:   { method: "curve", pct: 21 },
  100_000:   { method: "curve", pct: 21 },
  10_000:    { method: "curve", pct: 21 },
};

for (const [target, preset] of Object.entries(PRESETS)) {
  try {
    const p = preset.method === "curve"
      ? designCurve(1_000_000_000, preset.pct, Number(target), 1, 6, 9, 50, 0, lockedVesting, migrationFee, { baseFeeOption: baseFee })
      : designGraphCurve(1_000_000_000, preset.init, preset.mig, 1, 6, 9, 50, 0, lockedVesting, preset.leftOver, preset.k, baseFee);
    const t = Number(p.migrationQuoteThreshold.toString()) / 1e9;
    const err = Math.abs(t - Number(target)) / Number(target) * 100;
    console.log(`${target.padStart(10)} (${preset.method}): threshold = ${t.toLocaleString()} COOK   (err ${err.toFixed(3)}%)`);
  } catch (e: any) {
    console.log(`${target.padStart(10)} (${preset.method}): FAIL ${e.message?.slice(0, 80)}`);
  }
}

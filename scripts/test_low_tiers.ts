/**
 * Test low-end tier feasibility. designCurve pct=21 was confirmed to fail on-chain
 * for 50K threshold (BN precision). Need to find which low tiers actually work.
 */
import BN from "bn.js";
import { designCurve, getPriceFromSqrtPrice } from "../tests/utils/create_curve";

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
const BASE_SCALE = new BN(10).pow(new BN(6));

function simulateBuy(quoteRaw: BN, pMin: BN, curve: any[]): BN {
  let p = pMin;
  let quoteLeft = quoteRaw;
  let baseOut = new BN(0);
  const TWO_128 = new BN(1).shln(128);
  for (const seg of curve) {
    const L = seg.liquidity;
    const pU = seg.sqrtPrice;
    if (pU.lte(p)) continue;
    const fullQuote = L.mul(pU.sub(p)).div(TWO_128);
    if (quoteLeft.lte(fullQuote)) {
      const newP = p.add(quoteLeft.shln(128).div(L));
      const numer = L.mul(newP.sub(p));
      const denom = p.mul(newP).div(new BN(1).shln(64));
      baseOut = baseOut.add(numer.div(denom).div(new BN(1).shln(64)));
      return baseOut;
    } else {
      quoteLeft = quoteLeft.sub(fullQuote);
      const numer = L.mul(pU.sub(p));
      const denom = p.mul(pU).div(new BN(1).shln(64));
      baseOut = baseOut.add(numer.div(denom).div(new BN(1).shln(64)));
      p = pU;
    }
  }
  return baseOut;
}

// Note: local build success != on-chain success. The 50K fail was on-chain only.
// Locally simulate the on-chain validator: minimum_base_supply_with_buffer ≤ pre_supply
for (const target of [10, 50, 100, 500, 1000, 2000, 5000, 10000]) {
  try {
    const p = designCurve(1_000_000_000, 21, target, 1, 6, 9, 50, 0, lockedVesting, migrationFee, { baseFeeOption: baseFee });
    const t = Number(p.migrationQuoteThreshold.toString()) / 1e9;
    // Simulate on-chain validator check
    // swap_base = base from pStart to pMig (first curve point at pMig)
    // migration_base = post-grad LP allocation
    // buffer = swap_base × 1.25 capped at max_on_curve (entire 1B with second tier)
    // Failed when buffer + migration_base > 1B
    // Best proxy: just check designCurve threshold matches target
    const supplyRaw = new BN(1_000_000_000).mul(BASE_SCALE);
    const b1 = simulateBuy(p.migrationQuoteThreshold.muln(1).divn(100), p.sqrtStartPrice, p.curve);
    const pct1 = Number(b1.muln(10000).div(supplyRaw).toString()) / 100;
    const pMaxBN = p.curve[0].sqrtPrice;
    const fdv = getPriceFromSqrtPrice(pMaxBN, 6, 9).toNumber() * 1_000_000_000;
    console.log(`${target.toString().padStart(8)} COOK: threshold=${t} 1%buy=${pct1.toFixed(2)}% FDV/grad=${(fdv/t).toFixed(2)}× curves=${p.curve.length}`);
  } catch (e: any) {
    console.log(`${target.toString().padStart(8)} COOK: FAIL local — ${e.message?.slice(0, 60)}`);
  }
}

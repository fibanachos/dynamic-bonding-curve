import {
  AnchorProvider,
  Program,
  Wallet,
  BN,
  setProvider,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  SystemProgram,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

import idl from "../target/idl/dynamic_bonding_curve.json";
import type { DynamicBondingCurve } from "../target/types/dynamic_bonding_curve";
import { designCurve, designGraphCurve } from "../tests/utils/create_curve";

const PROGRAM_ID = new PublicKey(
  "DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf"
);

function loadKeypair(p: string): Keypair {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const RPC_URL = process.env.RPC_URL ?? "https://rpc.cookiescan.io";
  const ADMIN_KEYPAIR_PATH =
    process.env.ADMIN_KEYPAIR ?? "keys/local/upgrade-authority-live.json";
  const QUOTE_MINT = process.env.QUOTE_MINT
    ? new PublicKey(process.env.QUOTE_MINT)
    : NATIVE_MINT;

  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  setProvider(provider);

  const program = new Program<DynamicBondingCurve>(idl as any, provider);

  // pump.fun-style defaults
  const TOTAL_SUPPLY = 1_000_000_000; // curve math (1B)
  // Bucket presets — match deployed on-chain configs. Two design methods:
  //   'curve' = designCurve pct=21 (Uniswap V2 / pump.fun-exact). Used for 10K/100K/200K.
  //              Note: 50K with curve pct=21 hits BN precision in on-chain validator
  //              (InvalidTokenSupply error 6020). 50K tier dropped from ladder.
  //   'graph' = designGraphCurve. Used for 1M (designCurve caps at ~200K threshold).
  // All deployed configs give pump.fun-shaped distribution (2.89-3.23% supply @ 1% grad,
  // FDV/grad 4.76-5.14×, ~13-16× ROI on 5% pre-buy held to grad).
  // Override via `TARGET_GRAD_COOK=N` env var. Default = 1M.
  type GraphPreset = { method: "graph"; init: number; mig: number; k: number; leftOver: number };
  type CurvePreset = { method: "curve"; pct: number };
  const GRAD_PRESETS: Record<number, GraphPreset | CurvePreset> = {
    1_000_000: { method: "graph", init: 300_000, mig: 5_153_211, k: 1.0, leftOver: 1_000 }, // 3.23% supply @ 1% grad, FDV/grad 5.14×
    200_000:   { method: "curve", pct: 21 }, // 2.89% supply @ 1% grad, FDV/grad 4.76× (pump.fun-exact)
    100_000:   { method: "curve", pct: 21 }, // 2.89% supply @ 1% grad, FDV/grad 4.76×
    10_000:    { method: "curve", pct: 21 }, // 2.89% supply @ 1% grad, FDV/grad 4.76×
  };
  const TARGET_GRAD_COOK = Number(process.env.TARGET_GRAD_COOK ?? 1_000_000);
  const preset = GRAD_PRESETS[TARGET_GRAD_COOK];
  if (!preset) {
    throw new Error(
      `No preset for TARGET_GRAD_COOK=${TARGET_GRAD_COOK}. ` +
      `Sim-verify a new param tuple first, then add it to GRAD_PRESETS.`
    );
  }
  const MIGRATION_QUOTE_THRESHOLD = TARGET_GRAD_COOK; // target graduation quote
  const MIGRATION_OPTION = 1;          // 0 = MeteoraDamm, 1 = DammV2
  const TOKEN_BASE_DECIMAL = 6;
  const TOKEN_QUOTE_DECIMAL = 9;
  const FIXED_TOKEN_SUPPLY_RAW = new BN(1_000_000_000).mul(
    new BN(10).pow(new BN(TOKEN_BASE_DECIMAL))
  );
  const CREATOR_TRADING_FEE_PCT = 50;  // 50% of trading fee to token creator
  const COLLECT_FEE_MODE = 0;          // 0 = QuoteToken only

  // Post-migration locked-LP split (percent of migrated liquidity). The migrated
  // DAMM v2 pool charges 0.25% per swap, shared among LP holders by liquidity share,
  // so the creator's ongoing fee income ≈ CREATOR_LOCKED_LP_PCT * 0.25% of volume.
  // 30% ≈ 0.075% of volume — roughly Pump.fun's steady-state creator floor (~0.05%),
  // with headroom for dilution as outside LPs deposit. Permanent-locked = principal
  // never withdrawable (Pump.fun-like: creator gets the fee stream, not the LP).
  // Was creator 0 / partner 100 (all post-migration fees to the admin/fee_claimer).
  const CREATOR_LOCKED_LP_PCT = Number(process.env.CREATOR_LOCKED_LP_PCT ?? 30);
  const PARTNER_LOCKED_LP_PCT = 100 - CREATOR_LOCKED_LP_PCT;

  // Selects which pre-deployed DAMM v2 pool config receives migrated liquidity.
  // Cookie Chain mapping (post-migration LP fee on the DAMM v2 pool):
  //   0 = 0.25%  BgKTpMWBiSfdnxr8K6FmKsjV8LXpWZiS4a2xHk3M6Ymy
  //   1 = 0.30%  EEy8EQ1PMrHSwV7FWWHkg9eHhkK8m9XbAnrUYNT4cEyW
  //   2 = 1.00%  J3MPQDP4DBiyTfprAgYFkoKFxPEX6CsMVk1pWE18zdtu
  //   3 = 2.00%  HLkFoomCC4BM2D3RecXkZ6winosu3JyYC6PXtzPUnJ99
  //   4 = 4.00%  D4AK6wAwDmHk8Ty1uw9sRSDGhtDvg9EDh5KPy4mv1TC2
  //   6 = Customizable  2Jw57QDN4ZymWyzEg418Db3udLH8a8fjaXCkbEVSsx1b
  // pump.fun graduates with 0.25% LP fee → use option 0.
  const MIGRATION_FEE_OPTION = 0;

  const lockedVesting = {
    amountPerPeriod: new BN(0),
    cliffDurationFromMigrationTime: new BN(0),
    frequency: new BN(0),
    numberOfPeriod: new BN(0),
    cliffUnlockAmount: new BN(0),
  };

  const migrationFee = {
    feePercentage: 0,
    creatorFeePercentage: 0,
  };

  const baseFee = {
    baseFeeMode: 0,
    cliffFeeNumerator: new BN(10_000_000), // 1% (denom = 1e9)
    firstFactor: 0,
    secondFactor: new BN(0),
    thirdFactor: new BN(0),
  };

  const instructionParams =
    preset.method === "curve"
      ? designCurve(
          TOTAL_SUPPLY,
          preset.pct,
          MIGRATION_QUOTE_THRESHOLD,
          MIGRATION_OPTION,
          TOKEN_BASE_DECIMAL,
          TOKEN_QUOTE_DECIMAL,
          CREATOR_TRADING_FEE_PCT,
          COLLECT_FEE_MODE,
          lockedVesting,
          migrationFee,
          { baseFeeOption: baseFee }
        )
      : designGraphCurve(
          TOTAL_SUPPLY,
          preset.init,
          preset.mig,
          MIGRATION_OPTION,
          TOKEN_BASE_DECIMAL,
          TOKEN_QUOTE_DECIMAL,
          CREATOR_TRADING_FEE_PCT,
          COLLECT_FEE_MODE,
          lockedVesting,
          preset.leftOver,
          preset.k,
          baseFee
        );

  const thresholdCook =
    Number(instructionParams.migrationQuoteThreshold.toString()) / 10 ** TOKEN_QUOTE_DECIMAL;
  console.log(
    "Computed migrationQuoteThreshold:",
    thresholdCook.toLocaleString(),
    "COOK (target",
    MIGRATION_QUOTE_THRESHOLD.toLocaleString(),
    ")"
  );

  instructionParams.tokenSupply = {
    preMigrationTokenSupply: FIXED_TOKEN_SUPPLY_RAW,
    postMigrationTokenSupply: FIXED_TOKEN_SUPPLY_RAW,
  };

  instructionParams.migrationFeeOption = MIGRATION_FEE_OPTION;

  // Give the token creator a permanent-locked share of the migrated LP so they keep
  // earning post-migration trading fees (see CREATOR_LOCKED_LP_PCT above). Unlocked
  // and vesting stay 0 — the full pool remains locked, only the fee split changes.
  instructionParams.creatorPermanentLockedLiquidityPercentage = CREATOR_LOCKED_LP_PCT;
  instructionParams.partnerPermanentLockedLiquidityPercentage = PARTNER_LOCKED_LP_PCT;
  instructionParams.creatorLiquidityPercentage = 0;
  instructionParams.partnerLiquidityPercentage = 0;

  // Token metadata update authority (TokenAuthorityOption):
  //   0 = CreatorUpdateAuthority, 1 = Immutable, 2 = PartnerUpdateAuthority,
  //   3 = CreatorUpdateAndMintAuthority, 4 = PartnerUpdateAndMintAuthority.

  // 2 = partner (= feeClaimer = admin wallet below) can update name/ticker/URI
  // post-launch, but cannot mint supply or freeze accounts.
  // instructionParams.tokenUpdateAuthority = 2;

  // 1 = Immutable: token metadata (name/ticker/URI) can never be updated
  // post-launch, and no one can mint supply or freeze accounts.
  instructionParams.tokenUpdateAuthority = 1;

  if (instructionParams.migratedPoolMarketCapFeeSchedulerParams == null) {
    instructionParams.migratedPoolMarketCapFeeSchedulerParams = {
      numberOfPeriod: 0,
      sqrtPriceStepBps: 0,
      schedulerExpirationDuration: 0,
      reductionFactor: new BN(0),
    };
  }

  // Dynamic fee: caps at ~20% of base fee (0.2% on top of 1%) at max volatility.
  // Constants mirror programs/.../constants.rs::dynamic_fee.
  // variableFeeControl 956 derived from: target_max_numerator (base * 20%) * 1e11
  //   / (maxVolatilityAccumulator * binStep)^2 = 2_000_000 * 1e11 / 14_460_000^2 ≈ 956.
  instructionParams.poolFees.dynamicFee = {
    binStep: 1,
    binStepU128: new BN("1844674407370955"),
    filterPeriod: 10,
    decayPeriod: 120,
    reductionFactor: 5000,
    maxVolatilityAccumulator: 14_460_000,
    variableFeeControl: 956,
  };

  const config = Keypair.generate();

  console.log("Admin (payer / fee claimer / leftover receiver):", admin.publicKey.toBase58());
  console.log("Quote mint:", QUOTE_MINT.toBase58());
  console.log("New config pubkey:", config.publicKey.toBase58());

  const sig = await program.methods
    .createConfig({
      ...instructionParams,
      padding: new Array(2).fill(0),
    } as any)
    .accountsPartial({
      config: config.publicKey,
      feeClaimer: admin.publicKey,
      leftoverReceiver: admin.publicKey,
      quoteMint: QUOTE_MINT,
      payer: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin, config])
    .rpc();

  console.log("Tx:", sig);
  console.log("");
  console.log("DBC_CONFIG =", config.publicKey.toBase58());
  console.log("Paste this into cookiebox/src/solana/bonding/dbcConfigs.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

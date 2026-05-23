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
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

import idl from "../target/idl/dynamic_bonding_curve.json";
import type { DynamicBondingCurve } from "../target/types/dynamic_bonding_curve";

const PROGRAM_ID = new PublicKey(
  "DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf"
);
const TREASURY = new PublicKey(
  "Ba59QdKR9fYJ362zFWLmscBF625qsMmFategLzRSRZv2"
);
const U64_MAX = new BN("18446744073709551615");

function derivePoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    PROGRAM_ID
  )[0];
}

function deriveOperatorAddress(whitelisted: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), whitelisted.toBuffer()],
    PROGRAM_ID
  )[0];
}

function loadKeypair(p: string): Keypair {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const RPC_URL = process.env.RPC_URL ?? "https://rpc.cookiescan.io";
  const OPERATOR_KEYPAIR_PATH =
    process.env.OPERATOR_KEYPAIR ?? "keys/local/upgrade-authority-live.json";
  const POOL = process.env.POOL;

  if (!POOL) {
    throw new Error("Set POOL=<virtual-pool-pubkey>");
  }

  const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
  const pool = new PublicKey(POOL);

  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(operator), {
    commitment: "confirmed",
  });
  setProvider(provider);

  const program = new Program<DynamicBondingCurve>(idl as any, provider);

  const poolState = await program.account.virtualPool.fetch(pool);
  const configState = await program.account.poolConfig.fetch(poolState.config);

  const baseMint = poolState.baseMint;
  const quoteMint = configState.quoteMint;
  const baseVault = poolState.baseVault;
  const quoteVault = poolState.quoteVault;

  const tokenBaseProgram =
    (configState as any).tokenType === 0
      ? TOKEN_PROGRAM_ID
      : TOKEN_2022_PROGRAM_ID;
  const tokenQuoteProgram =
    (configState as any).quoteTokenFlag === 0
      ? TOKEN_PROGRAM_ID
      : TOKEN_2022_PROGRAM_ID;

  const tokenBaseAccount = getAssociatedTokenAddressSync(
    baseMint,
    TREASURY,
    true,
    tokenBaseProgram
  );
  const tokenQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    TREASURY,
    true,
    tokenQuoteProgram
  );

  const preInstructions: TransactionInstruction[] = [];
  const [baseAtaInfo, quoteAtaInfo] = await Promise.all([
    connection.getAccountInfo(tokenBaseAccount),
    connection.getAccountInfo(tokenQuoteAccount),
  ]);
  if (!baseAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        operator.publicKey,
        tokenBaseAccount,
        TREASURY,
        baseMint,
        tokenBaseProgram
      )
    );
  }
  if (!quoteAtaInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        operator.publicKey,
        tokenQuoteAccount,
        TREASURY,
        quoteMint,
        tokenQuoteProgram
      )
    );
  }

  const poolAuthority = derivePoolAuthority();
  const operatorPda = deriveOperatorAddress(operator.publicKey);

  console.log("Operator signer:", operator.publicKey.toBase58());
  console.log("Operator PDA:   ", operatorPda.toBase58());
  console.log("Pool:           ", pool.toBase58());
  console.log("Base mint:      ", baseMint.toBase58());
  console.log("Quote mint:     ", quoteMint.toBase58());
  console.log("Treasury base ATA:", tokenBaseAccount.toBase58());
  console.log("Treasury quote ATA:", tokenQuoteAccount.toBase58());

  const sig = await program.methods
    .claimProtocolFee(U64_MAX, U64_MAX)
    .accountsPartial({
      poolAuthority,
      config: poolState.config,
      pool,
      baseVault,
      quoteVault,
      baseMint,
      quoteMint,
      tokenBaseAccount,
      tokenQuoteAccount,
      operator: operatorPda,
      signer: operator.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram,
    })
    .preInstructions(preInstructions)
    .signers([operator])
    .rpc();

  console.log("Tx:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

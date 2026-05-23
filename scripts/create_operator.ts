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
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

import idl from "../target/idl/dynamic_bonding_curve.json";
import type { DynamicBondingCurve } from "../target/types/dynamic_bonding_curve";

const PROGRAM_ID = new PublicKey(
  "DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf"
);

enum OperatorPermission {
  ClaimProtocolFee = 0,
  ZapProtocolFee = 1,
}

function encodePermissions(perms: OperatorPermission[]): BN {
  return perms.reduce((acc, p) => acc.or(new BN(1).shln(p)), new BN(0));
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
  const ADMIN_KEYPAIR_PATH =
    process.env.ADMIN_KEYPAIR ?? "keys/local/upgrade-authority-live.json";
  const WHITELISTED = process.env.WHITELISTED;

  if (!WHITELISTED) {
    throw new Error(
      "Set WHITELISTED=<pubkey> (the address allowed to claim protocol fees)."
    );
  }

  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  const whitelistedAddress = new PublicKey(WHITELISTED);

  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  setProvider(provider);

  const program = new Program<DynamicBondingCurve>(idl as any, provider);

  const operatorPda = deriveOperatorAddress(whitelistedAddress);

  const existing = await connection.getAccountInfo(operatorPda);
  if (existing) {
    console.log("Operator PDA already exists:", operatorPda.toBase58());
    return;
  }

  const permission = encodePermissions([
    OperatorPermission.ClaimProtocolFee,
    OperatorPermission.ZapProtocolFee,
  ]);

  console.log("Admin (signer):", admin.publicKey.toBase58());
  console.log("Whitelisted:   ", whitelistedAddress.toBase58());
  console.log("Operator PDA:  ", operatorPda.toBase58());
  console.log("Permission:    ", permission.toString(), "(bitmap)");

  const sig = await program.methods
    .createOperatorAccount(permission)
    .accountsPartial({
      signer: admin.publicKey,
      operator: operatorPda,
      whitelistedAddress,
      payer: admin.publicKey,
    })
    .signers([admin])
    .rpc();

  console.log("Tx:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

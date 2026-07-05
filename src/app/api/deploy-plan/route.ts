/**
 * GET /api/deploy-plan?network=testnet|mainnet — the on-chain deploy manifest for a network:
 * the two infrastructure contracts + one `ParimutuelMarket` per catalogue market, with the exact
 * init/register args + house seed liquidity a deploy driver needs.
 *
 * Read-only + credential-free: it serialises the same public catalogue `/api/markets` already
 * exposes, just in "what to deploy on-chain" form. It is the S11 operator artifact — the mainnet
 * deploy is driven from this so the catalogue stays the single source of truth for on-chain state
 * (see `contracts/DEPLOY.md`). Defaults to `DEFAULT_NETWORK` when the param is missing/invalid.
 */

import { NextResponse } from "next/server";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { buildDeployManifest } from "@/core/deploy-manifest";

export async function GET(req: Request): Promise<Response> {
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  return NextResponse.json(buildDeployManifest(network));
}

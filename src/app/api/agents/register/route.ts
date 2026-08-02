/**
 * POST /api/agents/register — the public join path for a third-party Casper agent (S33/W2).
 *
 * Returns an **unsigned** `AgentRegistry::register` transaction carrying the bond, for the agent's
 * own wallet to sign. It never takes a key and never submits anything.
 *
 * That shape is forced by the contract, not chosen for convenience: `register` bonds
 * `env().caller()`. A registration this server signed would enrol the OPERATOR under the agent's
 * name — an entry naming a key the agent does not hold, which is strictly worse than no registry,
 * because it would look like accountable identity while being the opposite. The same reasoning
 * that made per-agent bet signing necessary (S30/W1) applies with more force here: a bond is
 * collateral, and collateral posted from someone else's purse secures nothing.
 *
 * GET returns the registry's policy — address, minimum bond, cooldown — so an agent can find out
 * what joining costs before it commits to anything.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { getNetworkConfig, isCasperNetwork, DEFAULT_NETWORK } from "@/config/network";
import { chainMode } from "@/config/chain-mode";
import { DEFAULT_REGISTER_AGENT_GAS_MOTES } from "@/adapters/casper/deploy-plan";

/** Bounds mirroring the contract's own field limits, so a doomed transaction is refused here. */
const MAX_NAME = 64;
const MAX_METADATA_URI = 256;
const MOTES = /^\d+$/;
/** A Casper public key hex: 01 (Ed25519) or 02 (Secp256k1) followed by the key bytes. */
const PUBLIC_KEY = /^0(1[0-9a-fA-F]{64}|2[0-9a-fA-F]{66})$/;

function networkFrom(req: Request) {
  const raw = new URL(req.url).searchParams.get("network");
  return isCasperNetwork(raw) ? raw : DEFAULT_NETWORK;
}

export async function GET(req: Request): Promise<Response> {
  const network = networkFrom(req);
  const registry = getNetworkConfig(network).contracts.agentRegistry;
  if (!registry) {
    return NextResponse.json(
      {
        available: false,
        reason:
          "no AgentRegistry deployed on this network — bonded identity is unavailable, and the League ranks unbonded agents",
      },
      { status: 200 },
    );
  }
  return NextResponse.json({
    available: true,
    network,
    registry,
    gasMotes: DEFAULT_REGISTER_AGENT_GAS_MOTES,
    howTo:
      "POST { network, name, metadataUri, bondMotes, agentPublicKeyHex } here, sign the returned " +
      "transaction with your own key, and submit it. The bond is refundable after you deactivate " +
      "and the cooldown elapses; read the live minimum with `registry-info` or from the contract.",
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const network = isCasperNetwork(body.network) ? body.network : networkFrom(req);
  const name = String(body.name ?? "").trim();
  const metadataUri = String(body.metadataUri ?? "").trim();
  const bondMotes = String(body.bondMotes ?? "").trim();
  const agentPublicKeyHex = String(body.agentPublicKeyHex ?? "").trim();

  if (name.length === 0 || name.length > MAX_NAME) {
    return NextResponse.json({ error: `name must be 1-${MAX_NAME} characters` }, { status: 400 });
  }
  if (metadataUri.length > MAX_METADATA_URI) {
    return NextResponse.json({ error: `metadataUri must be at most ${MAX_METADATA_URI} characters` }, { status: 400 });
  }
  if (!MOTES.test(bondMotes) || BigInt(bondMotes) <= 0n) {
    return NextResponse.json({ error: "bondMotes must be a positive integer motes string" }, { status: 400 });
  }
  // Validated here rather than left to the SDK: an unparseable key throws deep inside transaction
  // building, and "invalid public key" is a far more useful answer than a 500.
  if (!PUBLIC_KEY.test(agentPublicKeyHex)) {
    return NextResponse.json(
      { error: "agentPublicKeyHex must be a Casper public key hex (01… Ed25519 or 02… Secp256k1)" },
      { status: 400 },
    );
  }

  if (chainMode() !== "real") {
    return NextResponse.json(
      { error: "agent registration needs real chain mode — this instance is running in mock mode" },
      { status: 501 },
    );
  }
  if (!getNetworkConfig(network).contracts.agentRegistry) {
    return NextResponse.json(
      { error: `no AgentRegistry is deployed on ${network} — set NEXT_PUBLIC_${network.toUpperCase()}_AGENT_REGISTRY` },
      { status: 501 },
    );
  }

  const container = createContainer(network);
  if (!container.chain.buildAgentRegistrationTransaction) {
    return NextResponse.json({ error: "this chain cannot build unsigned agent registrations" }, { status: 501 });
  }

  try {
    const tx = await container.chain.buildAgentRegistrationTransaction({
      name,
      metadataUri,
      bondMotes,
      agentPublicKeyHex,
    });
    return NextResponse.json({
      network,
      registry: getNetworkConfig(network).contracts.agentRegistry,
      transactionJson: tx.transactionJson,
      transactionHash: tx.transactionHash,
      gasMotes: tx.gasMotes,
      bondMotes,
      note:
        "Sign this with the key whose public key you supplied and submit it. The registry bonds " +
        "the transaction's caller, so only that key becomes the registered agent.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not build the registration transaction" },
      { status: 502 },
    );
  }
}

/**
 * The 177 finalists of the Casper Agentic Buildathon 2026 — the candidate field of the
 * `casper-buildathon-2026-winner` market.
 *
 * Transcribed verbatim from the organizers' finals-eligibility announcement (21 Jul 2026).
 * The **id is the DoraHacks BUIDL id**, and it — not the name — is the on-chain outcome key:
 * five project names on that list are duplicated across different teams (Sluice, CasperFlow,
 * AgentPay, Verity, Steward), so a name-keyed field would silently merge two teams' pools into
 * one. The id is unique, five characters, and links straight back to the submission a bettor is
 * backing, which is also what makes every stake independently checkable.
 *
 * This list is frozen on chain by `FieldMarket::freeze_field` before the first bet: after that
 * no candidate can be added or removed, so the field a bettor bets into is the field that settles.
 */

import { sha256Hex } from "./sha256";

/**
 * The catalogue slug of the buildathon market. Lives in this leaf module rather than in the
 * catalogue because four layers must agree on it — the catalogue entry, the network config, the
 * contract routing and the /p/<buidl-id> pages — and importing the catalogue into the config
 * would be a cycle waiting to happen.
 */
export const BUILDATHON_MARKET_SLUG = "casper-buildathon-2026-winner";

/**
 * Slugs that live on a `FieldMarket` contract instead of `HunchVault`. A market listed here can
 * NOT fall back to the vault — its field is wider than `MAX_OUTCOMES` — so the routing throws
 * rather than sending a stake at a vault market that does not exist.
 */
export const FIELD_MARKET_SLUGS: readonly string[] = [BUILDATHON_MARKET_SLUG];

export interface Finalist {
  /** DoraHacks BUIDL id — the on-chain outcome key. */
  id: string;
  /** Project name as announced. Not unique; never used as a key. */
  name: string;
}

/** Ordered by BUIDL id (submission order), which is how the announcement listed them. */
export const BUILDATHON_FINALISTS: readonly Finalist[] = [
  { id: "40823", name: "OmniAgent" },
  { id: "44012", name: "Sasha — Autonomous Economic Actor" },
  { id: "44158", name: "Phoenix Zero — x402 Sequencer Health Oracle for Autonomous DeFi Agents" },
  { id: "44178", name: "AiFinPay" },
  { id: "44271", name: "Chainleash" },
  { id: "44340", name: "Agent Casper" },
  { id: "44347", name: "Asasanta Trust Agent" },
  { id: "44468", name: "Casper RWA Oracle Agent" },
  { id: "44481", name: "CasperRWA-Agent" },
  { id: "44632", name: "DepegGuard Strategy — Casper Agentic Signal Logger" },
  { id: "44752", name: "The Undesirables TCG Oracle" },
  { id: "44881", name: "CasperAgent Pay" },
  { id: "44970", name: "PharmaGuard Trust" },
  { id: "45016", name: "Trappist AI" },
  { id: "45308", name: "Aegis - a hardware key guard for autonomous AI payments" },
  { id: "45337", name: "sasha-x402-kit" },
  { id: "45348", name: "cred402" },
  { id: "45371", name: "CasperGuard — AI-Powered RWA Compliance Oracle Agent" },
  { id: "45462", name: "verity" },
  { id: "45467", name: "LIGIS" },
  { id: "45565", name: "Vouch — Trust Layer for the Casper Agent Economy" },
  { id: "45567", name: "Escrow402" },
  { id: "45586", name: "OutcomePay" },
  { id: "45588", name: "CasperFlow" },
  { id: "45601", name: "Casper AI Portfolio Agent" },
  { id: "45635", name: "earlynotwrong" },
  { id: "45639", name: "helios" },
  { id: "45659", name: "Custodian" },
  { id: "45724", name: "GrantFlow AI" },
  { id: "45839", name: "Chimera" },
  { id: "45903", name: "IP Breaker" },
  { id: "45907", name: "Casper HiveMind" },
  { id: "45992", name: "ProofPay Agent" },
  { id: "46001", name: "VaultWatch" },
  { id: "46006", name: "Casproof" },
  { id: "46008", name: "Caspilot" },
  { id: "46012", name: "Gold-guard-AI" },
  { id: "46014", name: "CasperSolvent" },
  { id: "46015", name: "Cadence" },
  { id: "46017", name: "AgentLedger" },
  { id: "46019", name: "BotNesia AI — Casper-Powered Business Agent Platform" },
  { id: "46025", name: "AgentPay" },
  { id: "46033", name: "RWA Intelligence Lab" },
  { id: "46036", name: "CasperAgentKit" },
  { id: "46040", name: "Crucible" },
  { id: "46045", name: "Quid" },
  { id: "46047", name: "CASPER-STATE" },
  { id: "46048", name: "NexusRWA" },
  { id: "46050", name: "Tribunal" },
  { id: "46053", name: "AgentPay Router" },
  { id: "46055", name: "Helios Protocol" },
  { id: "46056", name: "Bastion" },
  { id: "46057", name: "Conclave" },
  { id: "46058", name: "Verity" },
  { id: "46063", name: "Sluice" },
  { id: "46069", name: "CasperOPs - Trustworthy Agentic Infrastructure for Web3 & RWA" },
  { id: "46074", name: "Casper Sentinel" },
  { id: "46076", name: "Quittance" },
  { id: "46078", name: "Vault Cover" },
  { id: "46080", name: "CSPR402" },
  { id: "46085", name: "PeerRent" },
  { id: "46086", name: "MidOS" },
  { id: "46088", name: "VERDICTO" },
  { id: "46095", name: "LeaseFi" },
  { id: "46097", name: "CasperLaunch" },
  { id: "46116", name: "FanOracle Comic" },
  { id: "46121", name: "Caspergard" },
  { id: "46122", name: "Steward" },
  { id: "46127", name: "Sumplus Casper" },
  { id: "46129", name: "Weather Oracle" },
  { id: "46134", name: "ProofNav" },
  { id: "46138", name: "Casper Proof" },
  { id: "46139", name: "CasperGuard AI" },
  { id: "46145", name: "Cinder" },
  { id: "46147", name: "DERISK VAULT" },
  { id: "46149", name: "Agent Vault" },
  { id: "46158", name: "Casper Agent Mail Protocol" },
  { id: "46159", name: "Sawit Finance" },
  { id: "46160", name: "Claros" },
  { id: "46161", name: "defi - sentinel" },
  { id: "46165", name: "Casper Invoice Agent" },
  { id: "46172", name: "AnchorVault" },
  { id: "46177", name: "RWA Credit Sentinel" },
  { id: "46182", name: "Casper3643" },
  { id: "46187", name: "CasperGuard" },
  { id: "46197", name: "Trust Rail" },
  { id: "46306", name: "StigmAgent" },
  { id: "46354", name: "vewme" },
  { id: "46441", name: "Faktura" },
  { id: "46495", name: "vaultbench" },
  { id: "46574", name: "Caliber" },
  { id: "46594", name: "DAO Treasury Monitor" },
  { id: "46600", name: "SentinelOS" },
  { id: "46609", name: "Casper ProofPay: Revenue Proof Market for AI Agents" },
  { id: "46613", name: "Nox-x402 Settlement Relay" },
  { id: "46615", name: "Casper AgentShield" },
  { id: "46659", name: "Agent BlackBox" },
  { id: "46661", name: "BountyMesh AI" },
  { id: "46662", name: "Runway" },
  { id: "46664", name: "Veritas Custos" },
  { id: "46666", name: "Oja" },
  { id: "46667", name: "XELT" },
  { id: "46669", name: "Atmos" },
  { id: "46676", name: "CasperMind" },
  { id: "46679", name: "AgentGate" },
  { id: "46682", name: "ProxyKey" },
  { id: "46686", name: "Casper Trust Layer" },
  { id: "46689", name: "SafetyNet" },
  { id: "46694", name: "ARIA" },
  { id: "46696", name: "Hunch" },
  { id: "46699", name: "PICO_Payment_casper" },
  { id: "46700", name: "Cedar" },
  { id: "46703", name: "AgentPay Casper" },
  { id: "46704", name: "Alphx" },
  { id: "46706", name: "CSPR AgentPay Guard" },
  { id: "46707", name: "Casper X402 Pay-Per-UseAI" },
  { id: "46708", name: "RWA Compliance Guardian" },
  { id: "46714", name: "Triarchy // Agentic Mesh" },
  { id: "46715", name: "Casper sentinel AI" },
  { id: "46721", name: "FORGE Agent Certified Dataset Marketplace Exchange" },
  { id: "46722", name: "Codequity" },
  { id: "46723", name: "SealRail" },
  { id: "46724", name: "AVAL-Mou_Casper" },
  { id: "46729", name: "AgriTrust" },
  { id: "46730", name: "AgentPass" },
  { id: "46732", name: "Concordia DAO Council" },
  { id: "46733", name: "Casper Agent Network" },
  { id: "46737", name: "AutonomyHQ" },
  { id: "46741", name: "CSPR Sentinel" },
  { id: "46742", name: "Casper Carbon" },
  { id: "46744", name: "Liquidity Shield" },
  { id: "46745", name: "CanopyMRV" },
  { id: "46748", name: "Lastre" },
  { id: "46749", name: "eraya x casper" },
  { id: "46751", name: "AgentVault Guard" },
  { id: "46755", name: "Parking Revenue RWA Agent" },
  { id: "46757", name: "Casper Gateway" },
  { id: "46758", name: "GuildNet" },
  { id: "46759", name: "Casperflowpro" },
  { id: "46760", name: "Casper402-Sessions" },
  { id: "46761", name: "AgentOps" },
  { id: "46762", name: "Leash" },
  { id: "46765", name: "Evergreen" },
  { id: "46767", name: "Amanah — Autonomous Compliant RWA Treasury Agent" },
  { id: "46769", name: "Casper-Web-Stream" },
  { id: "46772", name: "Payward" },
  { id: "46774", name: "Magen3" },
  { id: "46775", name: "Writ" },
  { id: "46777", name: "Sluice" },
  { id: "46779", name: "Bondsman" },
  { id: "46780", name: "KARMA" },
  { id: "46781", name: "Pantheon" },
  { id: "46783", name: "Arzing AI" },
  { id: "46787", name: "Ulgen AI" },
  { id: "46790", name: "Casper Agentic Bot" },
  { id: "46791", name: "Arena" },
  { id: "46792", name: "Wardens Protocol" },
  { id: "46794", name: "CasperFlow" },
  { id: "46795", name: "Immortal: AI Workers That Never Die." },
  { id: "46796", name: "ATLAS - Smart AI Investment Agent" },
  { id: "46797", name: "Steward." },
  { id: "46798", name: "KaJota Coach — Agentic Commerce on Casper" },
  { id: "46801", name: "Layer402" },
  { id: "46803", name: "AGENT ARENA" },
  { id: "46805", name: "AgentPay" },
  { id: "46807", name: "Wisp Wallet: Multichain Agentic Wallet" },
  { id: "46808", name: "Tab402" },
  { id: "46809", name: "ARWA" },
  { id: "46811", name: "Payroll Vault" },
  { id: "46813", name: "SyNNdicate IP Vault" },
  { id: "46815", name: "CovenantOS" },
  { id: "46816", name: "AgentEscrow402" },
  { id: "46818", name: "Ohu: AI Agents that Pool Small Buyers into Big Buying Power" },
  { id: "46819", name: "Cortex" },
  { id: "46820", name: "CasperProver" },
  { id: "46821", name: "CasCet" },
  { id: "46822", name: "Baret" },
] as const;

/** The DoraHacks submission page for a finalist. */
export function buidlUrl(id: string): string {
  return `https://dorahacks.io/buidl/${id}`;
}

const BY_ID = new Map(BUILDATHON_FINALISTS.map((f) => [f.id, f]));

/** Look a finalist up by BUIDL id. */
export function findFinalist(id: string): Finalist | undefined {
  return BY_ID.get(id);
}

/**
 * The field commitment — `sha256` over the ordered candidate keys, joined by newline.
 *
 * `FieldMarket::freeze_field` stores this string and nothing else about the ordering: the
 * contract cannot see the list, and it does not need to. Anyone can take the published finalist
 * list, recompute this hash, and compare it with the contract's `field_hash()` — if they match,
 * the field that settles is provably the field they were shown. Recomputable from public data is
 * the whole point; a hash the operator alone can reproduce would prove nothing.
 */
export function fieldCommitment(
  ids: readonly string[] = BUILDATHON_FINALISTS.map((f) => f.id),
): string {
  return sha256Hex(ids.join("\n"));
}

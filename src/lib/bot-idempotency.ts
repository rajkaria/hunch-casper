/**
 * Mention-id idempotency for the chat bots — the guard that makes "a retried webhook never
 * double-bets" literally true.
 *
 * Telegram and X both retry a webhook they didn't get a `2xx` for, and a bet is the one action in
 * this system you must never replay: the platform re-delivering the same mention must place at most
 * one bet and return the same reply the first delivery produced. The payment layer already burns a
 * spent proof, but that fires *after* a fresh proof has been minted — too late to stop a retry that
 * re-mints one. So the guard sits at the very front of the handler, before any work: claim the
 * mention id, and only the claim's winner does anything.
 *
 * ## Concurrency
 *
 * The claim is a synchronous check-and-set on a `Map`, performed before the handler's first
 * `await`. JavaScript runs that check-and-set to completion with no interleaving, so two webhook
 * deliveries racing inside one instance cannot both win the claim: the first inserts a `pending`
 * marker, the second sees it. This is single-instance-correct, which is what the demo needs; a
 * multi-instance deployment would back the same interface with KV (`SET NX`) — the shape is chosen
 * so that swap is a one-file change, exactly like `economy-state.ts` did for the ledgers.
 *
 * Pure and injectable in the `abuse-guards.ts` style: every function takes the store map, so tests
 * pass their own and the routes pass the module singleton.
 */

/** The recorded outcome of processing one mention. */
export interface MentionRecord {
  /** `pending` while the claim's winner is still working; `done` once it has a reply. */
  status: "pending" | "done";
  /** The reply the first delivery produced — replayed verbatim to any retry. */
  reply?: string;
  /** The bet this mention placed, if any — so a replay can be observed as "already placed". */
  deployHash?: string;
  /** Epoch ms the claim was made — diagnostic, and the seam for a future TTL sweep. */
  claimedAtMs: number;
}

export type MentionClaim =
  | { fresh: true }
  | { fresh: false; record: MentionRecord };

/** The routes' shared idempotency state, keyed by `InboundMessage.mentionId`. */
export const MENTION_LEDGER = new Map<string, MentionRecord>();

/**
 * Atomically claim a mention id. The first caller gets `{ fresh: true }` and a `pending` marker is
 * recorded; every later caller gets `{ fresh: false, record }` with whatever the winner has stored
 * so far (a `pending` marker if it is still mid-flight, the final record once done).
 *
 * Synchronous on purpose — call it before any `await` so the check-and-set cannot interleave.
 */
export function claimMention(
  mentionId: string,
  nowMs: number,
  ledger: Map<string, MentionRecord> = MENTION_LEDGER,
): MentionClaim {
  const existing = ledger.get(mentionId);
  if (existing) return { fresh: false, record: existing };
  ledger.set(mentionId, { status: "pending", claimedAtMs: nowMs });
  return { fresh: true };
}

/** Record the final outcome of a claimed mention, so retries replay it. */
export function finalizeMention(
  mentionId: string,
  outcome: { reply: string; deployHash?: string },
  ledger: Map<string, MentionRecord> = MENTION_LEDGER,
): void {
  const existing = ledger.get(mentionId);
  ledger.set(mentionId, {
    status: "done",
    reply: outcome.reply,
    deployHash: outcome.deployHash,
    claimedAtMs: existing?.claimedAtMs ?? 0,
  });
}

/**
 * Release a claim without recording an outcome. Used when the winner throws *before* placing any
 * bet — the mention never touched the money path, so a retry should be allowed to try again rather
 * than being permanently answered with an error. (A throw *after* the bet is placed finalizes with
 * the placed reply instead, so that case is never released.)
 */
export function releaseMention(mentionId: string, ledger: Map<string, MentionRecord> = MENTION_LEDGER): void {
  ledger.delete(mentionId);
}

/** Test-only: forget every claimed mention. */
export function __resetMentionLedger(): void {
  MENTION_LEDGER.clear();
}

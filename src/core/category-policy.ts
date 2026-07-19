/**
 * The market category policy — the content filter that decides whether a market question is
 * allowed onto the board. It is the enforcement point for `docs/COMPLIANCE.md`: no markets on
 * death, violence, or harm to a person; no clearly illegal activity; no markets whose resolution
 * invites manipulation (a named individual's death/health, "assassination markets", rug-pull bait).
 *
 * Two hard requirements shape the implementation:
 *
 *   1. **It must reject the prohibited set.** Genesis (autonomous) and the S23 human composer both
 *      run every proposed market through `assessMarket` before it can exist, so a banned question
 *      never reaches the money path from either surface.
 *   2. **It must accept the existing catalogue.** A filter that also rejects "CSPR up or down this
 *      hour" (contains "down"), "deadline"-style phrasing, or "sudden death" sports overtime would
 *      be worse than useless. So matching is word-boundary and phrase-based, not substring, and the
 *      full catalogue is asserted to pass in the tests.
 *
 * Pure and deterministic — text in, verdict out — so the exact rejections are unit-tested and the
 * policy carries no dependency on an LLM. (An LLM may *draft* a market; it never *clears* one. What
 * is allowed is a rule, not a judgement call handed to a model.)
 */

export type PolicyReason =
  | "violence-or-death"
  | "harm-to-person"
  | "illegal-activity"
  | "manipulation-prone"
  | "hateful-or-abusive";

export interface PolicyVerdict {
  allowed: boolean;
  /** Present when `allowed` is false — the category that tripped, for logging + the user message. */
  reason?: PolicyReason;
  /** A one-line, user-facing explanation of the rejection. */
  message?: string;
}

/** A banned pattern with the reason it maps to. Patterns use `\b` boundaries to avoid substring
 * false positives ("dead" in "deadline", "war" in "warrant", "kill" in "skill"). */
interface Rule {
  reason: PolicyReason;
  pattern: RegExp;
  message: string;
}

const RULES: readonly Rule[] = [
  // Death / violence / weapons. "will ... die/be killed/be assassinated", explicit violence.
  {
    reason: "violence-or-death",
    pattern: /\b(assassinat\w*|murder\w*|be killed|is killed|gets killed|will kill|mass shooting|genocide|terror attack|bomb\w* (kill|attack|explod))\b/i,
    message: "markets on violence, killing, or terror are not allowed",
  },
  // A named person dying / their health — manipulation-prone and a target for real-world harm.
  {
    reason: "harm-to-person",
    pattern: /\b(will|does|is)\b[^?]*\b(die|dies|be dead|pass away|survive the year|health fails|overdose)\b/i,
    message: "markets predicting a person's death or health are not allowed",
  },
  // Explicitly illegal activity as the subject of the market.
  {
    reason: "illegal-activity",
    pattern: /\b(child (porn|abuse)|human trafficking|hire a hitman|sell (heroin|meth|fentanyl)|launder\w* money for)\b/i,
    message: "markets on illegal activity are not allowed",
  },
  // Manipulation-prone: insider knowledge, deliberate rug/pump-and-dump as the resolvable event.
  {
    reason: "manipulation-prone",
    pattern: /\b(rug ?pull|pump and dump|insider trad\w*|exit scam|will .* be assassinated)\b/i,
    message: "markets whose outcome invites manipulation are not allowed",
  },
  // Hateful / abusive targeting.
  {
    reason: "hateful-or-abusive",
    pattern: /\b(ethnic cleansing|racial slur|should\b[^?]*\bbe (killed|deported|eliminated|exterminated))\b/i,
    message: "hateful or abusive markets are not allowed",
  },
];

/**
 * Assess a market's free text (title, plus optionally subtitle/description joined in) against the
 * policy. Returns the first rule that trips, or an `allowed` verdict.
 */
export function assessMarket(text: string): PolicyVerdict {
  const normalized = text.normalize("NFKC");
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return { allowed: false, reason: rule.reason, message: rule.message };
    }
  }
  return { allowed: true };
}

/** Convenience for callers that hold structured market fields — checks title + subtitle + description. */
export function assessMarketFields(fields: {
  title: string;
  subtitle?: string;
  description?: string;
}): PolicyVerdict {
  const joined = [fields.title, fields.subtitle ?? "", fields.description ?? ""].join(" \n ");
  return assessMarket(joined);
}

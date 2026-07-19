/**
 * The bot command grammar — pure, strict, and shared by every chat surface.
 *
 * A Telegram message and an X mention are the same thing once the platform envelope is stripped:
 * a line of user-typed text that either *is* a command or is not. This module is the only place
 * that decides which, so Telegram and X can never disagree about what "bet 5 CSPR YES on foo"
 * means — and so the decision is testable without a live token, a webhook, or a network.
 *
 * ## Why the grammar is strict rather than forgiving
 *
 * This parser sits in front of the money path. A forgiving parser guesses, and a guess here is a
 * bet the user did not intend, in an amount they did not choose, on an outcome they did not pick.
 * So every rule below rejects rather than infers: no thousands separators, no scientific notation,
 * no unicode digits, no implicit outcome, no reordering, no trailing junk. The failure mode of a
 * strict parser is a user retyping a message; the failure mode of a loose one is somebody's CSPR.
 *
 * Non-ASCII is rejected outright for the same reason — `сspr-above-2` with a Cyrillic `с` is a
 * different string from `cspr-above-2`, and a homoglyph slug that silently resolves elsewhere is a
 * phishing primitive, not a convenience.
 *
 * ## Platform decoration
 *
 * Two rules, both explicit, both tested — nothing else is stripped:
 *
 *  1. Leading `@mention` tokens are dropped (this is how X addresses the bot at all, and how
 *     Telegram group members address it: `@hunchcasper bet …`).
 *  2. Trailing `@mention` / `#hashtag` tokens are dropped, and a single trailing URL is dropped
 *     *only if* the command parses without it — X appends a `t.co` link when the author quotes or
 *     attaches something, and that link is decoration, not an argument.
 *
 * Mentions in the *middle* are not stripped: `bet 5 @someone YES on foo` is ambiguous about who
 * or what `@someone` is, so it is rejected rather than quietly reinterpreted.
 *
 * ## Grammar
 *
 *     command  := help | markets | odds | bet
 *     help     := ("help" | "/help" | "?")
 *     markets  := ("markets" | "/markets" | "list") [ count ]
 *     odds     := ("odds" | "/odds" | "price") slugref
 *     bet      := ("bet" | "/bet") amount [ "cspr" ] outcome "on" slugref
 *     amount   := digits [ "." digits(1..9) ]        -- exact decimal CSPR, no float anywhere
 *     outcome  := [a-z][a-z0-9_-]{0,31}              -- an outcome key, e.g. yes / no / up / heads
 *     slugref  := slug | market-url                  -- a catalogue slug, or a link to one
 *
 * Keywords are case-insensitive; slugs and outcome keys are lowercased before validation, so
 * `YES` and `yes` are the same outcome and `Cspr-Above-2` is the same market.
 */

/** Longest input this parser will look at. Anything past it is a payload, not a command. */
export const MAX_COMMAND_CHARS = 512;

/** Grammar-level sanity ceiling on a single bet, in CSPR. The network cap is enforced downstream
 * (`config/network.ts`) — this one only exists so an absurd literal fails at the parser instead of
 * travelling through the bet path to die there. */
export const MAX_BET_CSPR = 1_000_000;

/** Default and maximum number of markets a `markets` command lists. */
export const DEFAULT_MARKET_LIST = 5;
export const MAX_MARKET_LIST = 20;

export type BotCommand =
  | { kind: "help" }
  | { kind: "markets"; limit: number }
  | { kind: "odds"; slug: string }
  | { kind: "bet"; slug: string; outcomeKey: string; amountMotes: string; amountCspr: string };

export type BotCommandParse =
  | { ok: true; command: BotCommand }
  | { ok: false; error: string; hint: string };

const AMOUNT = /^(0|[1-9]\d{0,11})(\.\d{1,9})?$/;
const OUTCOME = /^[a-z][a-z0-9_-]{0,31}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MENTION = /^@[^\s]+$/;
const HASHTAG = /^#[^\s]+$/;
const URL_TOKEN = /^https?:\/\/[^\s]+$/i;
/** Printable ASCII only. Excludes control characters, NUL, and every non-ASCII codepoint. */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

const HELP_WORDS = new Set(["help", "/help", "?"]);
const MARKET_WORDS = new Set(["markets", "/markets", "list"]);
const ODDS_WORDS = new Set(["odds", "/odds", "price"]);
const BET_WORDS = new Set(["bet", "/bet"]);

const USAGE =
  "try: `bet 5 CSPR YES on <market-slug>` · `odds <market-slug>` · `markets` · `help`";

function fail(error: string, hint: string = USAGE): BotCommandParse {
  return { ok: false, error, hint };
}

/**
 * Exact decimal-CSPR → motes. String arithmetic on purpose: `Number("0.000000001") * 1e9` is not
 * 1 in IEEE-754, and a bet amount that is off by a mote because of binary rounding is a bug that
 * only ever shows up in somebody's balance. Assumes `AMOUNT` has already matched.
 */
export function csprTextToMotes(text: string): string {
  const [whole, frac = ""] = text.split(".");
  const nanos = (frac + "000000000").slice(0, 9);
  return (BigInt(whole) * 1_000_000_000n + BigInt(nanos)).toString();
}

/**
 * A slug reference is either a bare slug or a link to one of our own market/embed pages. The host
 * is deliberately NOT checked: a user pasting a link from a preview deployment, a custom domain,
 * or a localhost dev server means the same market, and the slug still has to survive `SLUG`
 * validation and then actually exist in the store. What matters is the path shape.
 */
function slugFromToken(token: string): string | null {
  let candidate = token;
  if (URL_TOKEN.test(token)) {
    let path: string;
    try {
      path = new URL(token).pathname;
    } catch {
      return null;
    }
    const match = /^\/(?:markets|embed)\/([^/]+)\/?$/.exec(path);
    if (!match) return null;
    try {
      candidate = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }
  const lowered = candidate.toLowerCase();
  if (lowered.length > 80 || !SLUG.test(lowered)) return null;
  return lowered;
}

/** Split on any whitespace run, dropping empties. Newlines are separators like any other space. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Parse one message into a command.
 *
 * Returns a structured refusal rather than throwing: every caller is a webhook that must reply to
 * the user with something useful, and "what you typed, and what to type instead" is the only
 * useful thing to say.
 */
export function parseBotCommand(rawText: string): BotCommandParse {
  if (typeof rawText !== "string") return fail("no message text");
  if (rawText.length > MAX_COMMAND_CHARS) {
    return fail(`message is longer than ${MAX_COMMAND_CHARS} characters`);
  }
  if (!PRINTABLE_ASCII.test(rawText)) {
    return fail(
      "message contains non-ASCII or control characters",
      "commands are plain ASCII — a lookalike character in a slug is not the same market",
    );
  }

  let tokens = tokenize(rawText);
  // Rule 1: leading mentions address the bot; they are envelope, not argument.
  while (tokens.length > 0 && MENTION.test(tokens[0])) tokens = tokens.slice(1);
  // Rule 2a: trailing hashtags/mentions are decoration.
  while (tokens.length > 0 && (HASHTAG.test(tokens[tokens.length - 1]) || MENTION.test(tokens[tokens.length - 1]))) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) return fail("empty command");

  const first = parseTokens(tokens);
  if (first.ok) return first;
  // Rule 2b: a single trailing URL is decoration ONLY if dropping it makes the command parse.
  // Attempted after the fact so `odds https://…/markets/foo` still reads the URL as the argument.
  if (tokens.length > 1 && URL_TOKEN.test(tokens[tokens.length - 1])) {
    const retry = parseTokens(tokens.slice(0, -1));
    if (retry.ok) return retry;
  }
  return first;
}

function parseTokens(tokens: string[]): BotCommandParse {
  const verb = tokens[0].toLowerCase();

  if (HELP_WORDS.has(verb)) {
    if (tokens.length > 1) return fail("`help` takes no arguments");
    return { ok: true, command: { kind: "help" } };
  }

  if (MARKET_WORDS.has(verb)) {
    if (tokens.length === 1) return { ok: true, command: { kind: "markets", limit: DEFAULT_MARKET_LIST } };
    if (tokens.length > 2) return fail("`markets` takes at most a count", "try: `markets 10`");
    if (!/^[1-9]\d{0,2}$/.test(tokens[1])) {
      return fail(`'${tokens[1]}' is not a market count`, "try: `markets 10`");
    }
    const limit = Math.min(Number(tokens[1]), MAX_MARKET_LIST);
    return { ok: true, command: { kind: "markets", limit } };
  }

  if (ODDS_WORDS.has(verb)) {
    if (tokens.length !== 2) return fail("`odds` needs exactly one market", "try: `odds cspr-above-2`");
    const slug = slugFromToken(tokens[1]);
    if (!slug) return fail(`'${tokens[1]}' is not a market slug`, "try: `odds cspr-above-2`");
    return { ok: true, command: { kind: "odds", slug } };
  }

  if (BET_WORDS.has(verb)) return parseBet(tokens);

  return fail(`unknown command '${tokens[0]}'`);
}

function parseBet(tokens: string[]): BotCommandParse {
  // bet <amount> [cspr] <outcome> on <slug>  →  5 or 6 tokens.
  let rest = tokens.slice(1);
  if (rest.length === 0) return fail("`bet` needs an amount, an outcome and a market");

  const amountText = rest[0];
  if (!AMOUNT.test(amountText)) {
    return fail(
      `'${amountText}' is not a CSPR amount`,
      "amounts are plain decimals with at most 9 places — `5`, `0.25`, `12.5`",
    );
  }
  const amountMotes = csprTextToMotes(amountText);
  if (BigInt(amountMotes) <= 0n) return fail("bet amount must be greater than zero");
  if (BigInt(amountMotes) > BigInt(MAX_BET_CSPR) * 1_000_000_000n) {
    return fail(`bet amount is above the ${MAX_BET_CSPR.toLocaleString("en-US")} CSPR ceiling`);
  }
  rest = rest.slice(1);

  // The unit is optional and, when present, must be exactly CSPR — a bet denominated in something
  // this market does not settle in is a misunderstanding worth surfacing, not one worth ignoring.
  if (rest.length > 0 && rest[0].toLowerCase() === "cspr") rest = rest.slice(1);

  if (rest.length !== 3) {
    return fail(
      "`bet` reads: amount, outcome, `on`, market",
      "try: `bet 5 CSPR YES on cspr-above-2`",
    );
  }
  const [outcomeToken, onToken, slugToken] = rest;

  const outcomeKey = outcomeToken.toLowerCase();
  if (!OUTCOME.test(outcomeKey) || outcomeKey === "on") {
    return fail(`'${outcomeToken}' is not an outcome`, "outcomes look like `YES`, `NO`, `UP`, `HEADS`");
  }
  if (onToken.toLowerCase() !== "on") {
    return fail("`bet` needs the word `on` before the market", "try: `bet 5 CSPR YES on cspr-above-2`");
  }
  const slug = slugFromToken(slugToken);
  if (!slug) return fail(`'${slugToken}' is not a market slug`, "try: `bet 5 CSPR YES on cspr-above-2`");

  return { ok: true, command: { kind: "bet", slug, outcomeKey, amountMotes, amountCspr: amountText } };
}

/** The `help` reply body — one string, so both platforms and the tests read the same text. */
export function helpText(): string {
  return [
    "Hunch on Casper — bet from chat.",
    "",
    "• `bet 5 CSPR YES on <market>` — place a bet",
    "• `odds <market>` — live pool-implied odds",
    "• `markets` — what's open right now",
    "• `help` — this message",
    "",
    "Markets are parimutuel: the winning side splits the pool. Odds move as people bet.",
  ].join("\n");
}

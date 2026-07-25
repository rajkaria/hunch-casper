# Hunch on Casper — "Signal Floor" design system

The product is a self-running prediction market: an economy of autonomous agents that
never stops trading. The design language makes that literal — the UI reads as a **live
trading terminal**, not a brochure. Every screen should feel like it is *running*.

Implementation lives in [`src/app/globals.css`](../src/app/globals.css) (tokens,
keyframes, component classes) plus three animation primitives in `src/components/`:
`reveal.tsx`, `animated-number.tsx`, `loop-diagram.tsx`, `market-ticker.tsx`.

## Principles

1. **Data is mono.** Anything that is a number, a hash, a label, or a probability is set
   in Geist Mono with `tabular-nums` (`.num`, `.eyebrow`). Prose stays in Geist Sans.
2. **The board is live, never printed.** Odds bars carry a slow sheen, tickers scroll,
   dots ping, satellites orbit. Motion says "this ran a second ago", not "look at me".
3. **One signal colour.** Red (`--accent`) is the primary action + brand signal. Violet,
   gold, and green are *role* colours (see below), never decoration.
4. **Restraint at rest, glow on intent.** Cards are flat until hovered; buttons carry the
   only always-on glow. Nothing pulses that isn't genuinely live.
5. **Reduced motion is first-class.** A global `prefers-reduced-motion` rule zeroes every
   animation and transition; the site is fully usable frozen.

## Color tokens

Same family as v1, tuned for glow work. All defined on `:root` and mapped into Tailwind
via `@theme inline` (use as `bg-surface-2`, `text-accent`, `border-border-strong`, …).

| Token | Value | Use |
| --- | --- | --- |
| `--background` | `#060609` | Page canvas |
| `--surface` / `-2` / `-3` | `#0d0d14` / `#14141d` / `#1b1b27` | Elevation steps |
| `--border` / `--border-strong` | `#232331` / `#323244` | Hairlines / interactive borders |
| `--foreground` | `#f5f5f8` | Primary ink |
| `--muted` / `--muted-2` | `#9d9dae` / `#6f6f80` | Secondary / tertiary ink |
| `--accent` (+`-bright`) | `#ff3b3b` / `#ff6257` | Brand signal, CTAs, Genesis |
| `--accent-2` | `#8b7bff` | Violet — Arbiter / meta |
| `--gold` | `#e8c66b` | Vault / provably-fair |
| `--up` / `--down` | `#35d0a0` / `#ff6a6a` | Gains, Prophets / losses, errors |

Alpha ramps (`--accent-glow`, `--accent-wash`, `--violet-glow`, …) exist for shadows and
washes — never hand-roll an rgba of a brand colour.

**Agent role colours** (used consistently everywhere an agent is named): Genesis = red,
Prophets = green, Arbiter = violet, Vault = gold.

## Typography

- Display: Geist Sans, `font-semibold tracking-tight`, sizes `text-4xl → text-7xl`.
  Hero headline may use `.text-glow-red` (white→red gradient clip) on the key phrase.
- Section titles: `text-2xl sm:text-3xl font-semibold tracking-tight`.
- Every section opens with an `.eyebrow` — mono, uppercase, letter-spaced, colored by
  the section's role colour, prefixed with a 20px rule.
- Body: `text-sm/base leading-relaxed text-muted`, max width `max-w-2xl`.

## Motion

Tokens: `--ease-out` (quart), `--ease-spring`, `--dur-fast` 150ms, `--dur-base` 300ms,
`--dur-slow` 700ms.

| Pattern | Class | Behavior |
| --- | --- | --- |
| Scroll reveal | `.reveal` + `<Reveal>` | fade + 18px rise, staggered via `--reveal-delay` |
| Count-up | `<AnimatedNumber>` | numbers roll up when scrolled into view |
| Ticker | `.marquee` (+`<MarketTicker>`) | edge-masked infinite scroll, pauses on hover |
| Odds sheen | `.odds-fill` | slow highlight sweep across probability bars |
| Loop diagram | `.loop-*` | dashes flow around the agent ring; satellites orbit |
| Aurora | `.hero-aurora` | two blurred red/violet orbs drifting behind the hero |
| Skeleton | `.skeleton` | shimmer while data loads |
| Live dot | `.live-dot` | ping for anything genuinely running |

## Components

- **Buttons**: `.btn .btn-primary` (red gradient, glow, hover lift) and
  `.btn .btn-ghost` (hairline, warms to red). Never a bare `<a>` for a CTA.
- **Cards**: `.card` (gradient surface + hairline). Add `.card-hover` when clickable,
  `.card-signal` with `style={{"--card-accent": …}}` for a 2px signal line on top.
- **Chips**: `.chip` — mono-ish micro-labels, filters, statuses.
- **Odds bars**: `.odds-track > .odds-fill`, colour via `--bar-color`.
- **Backgrounds**: `.bg-grid` dot-grid, `.band` for alternating section washes,
  `.hero-aurora` only on the landing hero and the closing CTA.
- **Nav**: `.nav-link` (animated red underline), `.logo-mark` (glowing H tile).

## Layout rhythm

`max-w-6xl` container, `px-4 sm:px-6`. Sections: `py-20 sm:py-24`, alternating plain and
`.band`. Section header stack: eyebrow → title → one-paragraph description → content
grid with `gap-4`. Grids collapse `4 → 2 → 1` (`sm:grid-cols-2 lg:grid-cols-4`).

## Voice

Copy is confident, specific, and auditable — "recompute it yourself", "receipts, not
vibes". Numbers over adjectives. Never imply custody, liquidity, or a prize that isn't
real; honest empty states beat confident zeroes.

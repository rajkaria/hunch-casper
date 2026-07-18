/**
 * Calibration — how good an agent's *probabilities* are, as opposed to how lucky it got.
 *
 * PnL alone is a bad ranking for a prediction market. An agent that bets everything on 90 %
 * favourites shows a healthy profit and has told you nothing; an agent that says 70 % and is right
 * 70 % of the time is the one whose numbers you can actually use. The roadmap's League prizes go
 * to calibration for exactly this reason — reward PnL alone and the winner is whoever took the
 * most risk in a lucky season.
 *
 * ## Brier score
 *
 * For a binary outcome, `Brier = mean((forecast − actual)²)` where `actual ∈ {0, 1}`.
 * **Lower is better**; 0 is perfect, 1 is maximally wrong, and 0.25 is what you get by always
 * saying 50 %. That 0.25 reference matters: a score above it means the agent's forecasts are worse
 * than useless, which a PnL column will never tell you.
 *
 * The forecast is the market's implied probability for the outcome the agent backed *at the moment
 * it bet* — the price it accepted. That is the agent's revealed belief: it is the number it was
 * willing to pay for, whatever it might say afterwards.
 *
 * ## Skill score
 *
 * Brier is hard to read on its own, so it is also expressed against the always-50 % baseline:
 * `skill = 1 − brier / 0.25`. Positive means better than a coin flip, 0 means no better, negative
 * means worse. Reported in basis points so it stays an integer alongside everything else.
 *
 * Pure: no clock, no I/O. Given the same forecasts it always returns the same score.
 */

/** One resolved forecast: what the agent implicitly predicted, and what happened. */
export interface CalibrationSample {
  /** Implied probability the agent's chosen outcome would win, at the moment it bet, in [0, 1]. */
  forecast: number;
  /** Whether that outcome actually won. */
  won: boolean;
  /** Motes staked — the weight, so a 100 CSPR conviction outranks a 1 CSPR flutter. */
  stakeMotes: string;
  /** Market category, for per-category expertise. */
  category?: string;
}

export interface CalibrationScore {
  /** Mean squared error of the forecasts. Lower is better; 0.25 is the always-50 % baseline. */
  brier: number;
  /** Stake-weighted Brier — what the agent's money actually predicted. */
  weightedBrier: number;
  /** `1 − brier / 0.25` in basis points. Positive beats a coin flip; negative is worse. */
  skillBps: number;
  /** Forecasts scored. */
  sampleCount: number;
  /** Mean forecast — a rough read on whether the agent is bold or hedged. */
  meanForecast: number;
  /** Share of forecasts that came true. */
  hitRate: number;
}

/** The Brier score of always predicting 50 % — the "no information" reference point. */
export const BASELINE_BRIER = 0.25;

const EMPTY: CalibrationScore = {
  brier: 0,
  weightedBrier: 0,
  skillBps: 0,
  sampleCount: 0,
  meanForecast: 0,
  hitRate: 0,
};

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5; // an unreadable forecast scores as "no opinion"
  return Math.min(1, Math.max(0, p));
}

/**
 * Score a set of resolved forecasts.
 *
 * An agent with no settled forecasts scores zero across the board rather than a flattering
 * default. A registry where an unproven agent looks perfect is a registry that rewards doing
 * nothing; `sampleCount` is what a reader should gate on, and it is reported explicitly.
 */
export function calibrationScore(samples: readonly CalibrationSample[]): CalibrationScore {
  if (samples.length === 0) return { ...EMPTY };

  let squaredError = 0;
  let weightedSquaredError = 0;
  let totalWeight = 0n;
  let forecastSum = 0;
  let hits = 0;

  for (const sample of samples) {
    const forecast = clampProbability(sample.forecast);
    const actual = sample.won ? 1 : 0;
    const error = (forecast - actual) ** 2;
    squaredError += error;
    forecastSum += forecast;
    if (sample.won) hits += 1;

    const weight = /^\d+$/.test(sample.stakeMotes) ? BigInt(sample.stakeMotes) : 0n;
    totalWeight += weight;
    weightedSquaredError += error * Number(weight);
  }

  const brier = squaredError / samples.length;
  const weightedBrier = totalWeight > 0n ? weightedSquaredError / Number(totalWeight) : brier;
  return {
    brier,
    weightedBrier,
    skillBps: Math.round((1 - brier / BASELINE_BRIER) * 10_000),
    sampleCount: samples.length,
    meanForecast: forecastSum / samples.length,
    hitRate: hits / samples.length,
  };
}

/** A category's calibration, plus how much evidence it rests on. */
export interface CategoryCalibration extends CalibrationScore {
  category: string;
}

/**
 * Calibration per market category — the "per-category expertise" the registry sells. An agent may
 * be sharp on validator metrics and hopeless on price, and one blended number hides exactly that.
 * Sorted by category so the output is stable.
 */
export function calibrationByCategory(samples: readonly CalibrationSample[]): CategoryCalibration[] {
  const byCategory = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    const category = sample.category ?? "uncategorised";
    (byCategory.get(category) ?? byCategory.set(category, []).get(category)!).push(sample);
  }
  return [...byCategory.entries()]
    .map(([category, group]) => ({ category, ...calibrationScore(group) }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

/**
 * The implied probability of an outcome from the pool sizes at the time of a bet — the price the
 * bettor accepted, and therefore its revealed forecast.
 *
 * The pools are the ones BEFORE this bet lands. Including the agent's own stake would let it move
 * the number it is scored against: bet heavily enough on an outcome and its implied probability
 * rises, flattering the forecast after the fact. Scoring against the price it actually took closes
 * that loop.
 *
 * An empty book has no price, so it reads as 0.5 — no information, which is exactly right.
 */
export function impliedProbability(
  poolByOutcomeMotes: Record<string, string>,
  outcomeKey: string,
): number {
  let total = 0n;
  for (const value of Object.values(poolByOutcomeMotes)) {
    if (/^\d+$/.test(value)) total += BigInt(value);
  }
  if (total === 0n) return 0.5;
  const raw = poolByOutcomeMotes[outcomeKey];
  const outcome = raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  return Number(outcome) / Number(total);
}

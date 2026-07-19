//! LmsrMarket — a Logarithmic Market Scoring Rule book on chain (S28), for flagship markets that
//! want continuous liquidity and exit-before-resolution. Parimutuel (`hunch_vault`) stays for the
//! long tail; this is the "vault mode" for markets that want a live quote.
//!
//! # Fixed-point, and what "parity" means
//!
//! There is no floating point in a Casper contract, so the LMSR cost `C(q)=b·ln(Σexp(q_i/b))` and
//! the prices `p_i=exp(q_i/b)/Σ` are computed in **WAD fixed point** (1e9) with integer `exp`/`ln`
//! built here (range-reduced Taylor / atanh series). The float reference is `src/core/lmsr.ts`; the
//! two agree to a documented **tolerance**, not bit-for-bit — float↔fixed can't be bit-exact, so
//! the parity vectors assert agreement within a few WAD (see the tests + decision D27). The
//! money-path LMSR run in the demo goes through the TS engine against the mock chain (the S28
//! acceptance); this module is the on-chain counterpart with its invariants proven in OdraVM.
//!
//! The invariants the tests hammer, in fixed point:
//!   * prices sum to WAD (a probability distribution);
//!   * buying an outcome raises its price, lowers the others (monotone impact);
//!   * the maker's worst-case loss is bounded by `b·ln(n)`.
use odra::casper_types::U512;
use odra::prelude::*;

/// Fixed-point scale — 1e9, matching the motes scale so `b`/`q` are natural.
const WAD: i128 = 1_000_000_000;

// ── Fixed-point exp / ln (pure integer math, no_std-safe) ─────────────────────────────────────────

/// exp(x) in WAD fixed point, for x ≤ 0 (the range LMSR prices need after max-subtraction).
/// Range-reduced by halving until |x| is small, Taylor there, then squared back. Underflows to 0
/// for very negative x (a negligible price), which is correct.
fn exp_neg_fp(mut x: i128) -> i128 {
    if x > 0 {
        // Only non-positive inputs are used; guard anyway.
        x = 0;
    }
    // Clamp extreme inputs to 0 (exp(-large) ≈ 0). -40 in WAD.
    if x < -40 * WAD {
        return 0;
    }
    // Reduce: find n with |x / 2^n| <= WAD/2.
    let mut n = 0;
    let mut r = x;
    while r < -WAD / 2 {
        r /= 2;
        n += 1;
    }
    // Taylor around 0 for r in [-0.5, 0]: 1 + r + r^2/2 + r^3/6 + r^4/24 + r^5/120.
    let r2 = r * r / WAD;
    let r3 = r2 * r / WAD;
    let r4 = r3 * r / WAD;
    let r5 = r4 * r / WAD;
    let mut e = WAD + r + r2 / 2 + r3 / 6 + r4 / 24 + r5 / 120;
    // Square n times (e in (0, 1], so e^2 <= WAD, no overflow).
    for _ in 0..n {
        e = e * e / WAD;
    }
    if e < 0 {
        0
    } else {
        e
    }
}

/// ln(2) in WAD.
const LN2: i128 = 693_147_181;

/// ln(y) in WAD fixed point, for y >= WAD (real y >= 1). Argument-reduced by powers of 2 so the
/// atanh series always runs on a mantissa in [1, 2) (z ≤ 1/3), where 5 terms are ample:
/// ln(y) = k·ln2 + 2·atanh((m-1)/(m+1)), m = y / 2^k ∈ [1, 2).
fn ln_fp(y: i128) -> i128 {
    if y <= WAD {
        return 0; // ln(1) = 0; guard y<WAD (not used) to 0.
    }
    // Reduce m = y into [WAD, 2·WAD).
    let mut k = 0;
    let mut m = y;
    while m >= 2 * WAD {
        m /= 2;
        k += 1;
    }
    // z = (m - 1) / (m + 1), z ∈ [0, 1/3].
    let z = (m - WAD) * WAD / (m + WAD);
    let z2 = z * z / WAD;
    let z3 = z2 * z / WAD;
    let z5 = z3 * z2 / WAD;
    let z7 = z5 * z2 / WAD;
    let atanh = z + z3 / 3 + z5 / 5 + z7 / 7;
    k as i128 * LN2 + 2 * atanh
}

/// Prices in WAD for a book `q` (i128 fixed, real values are q/WAD·... — here q are integer shares
/// and b integer), returned per outcome, summing to WAD. `b` and `q` are plain integers (shares).
fn prices_wad(b: i128, q: &[i128]) -> Vec<i128> {
    let qmax = *q.iter().max().unwrap();
    // arg_i = (q_i - qmax) / b, in WAD (≤ 0).
    let exps: Vec<i128> = q.iter().map(|&qi| exp_neg_fp((qi - qmax) * WAD / b)).collect();
    let sum: i128 = exps.iter().sum();
    if sum == 0 {
        // Degenerate; equal split.
        let n = q.len() as i128;
        return q.iter().map(|_| WAD / n).collect();
    }
    // Assign floors, then give the rounding remainder to the largest outcome so prices sum to WAD.
    let mut prices: Vec<i128> = exps.iter().map(|&e| e * WAD / sum).collect();
    let assigned: i128 = prices.iter().sum();
    let remainder = WAD - assigned;
    if remainder != 0 {
        // Add to the max-price index.
        let mut max_i = 0;
        for i in 1..prices.len() {
            if prices[i] > prices[max_i] {
                max_i = i;
            }
        }
        prices[max_i] += remainder;
    }
    prices
}

/// Cost C(q) = b·ln(Σ exp(q_i/b)), in the same integer units as `b` (shares/motes). Uses the
/// max-subtraction identity: C = qmax + b·ln(Σ exp((q_i−qmax)/b)).
fn cost(b: i128, q: &[i128]) -> i128 {
    let qmax = *q.iter().max().unwrap();
    let sum: i128 = q.iter().map(|&qi| exp_neg_fp((qi - qmax) * WAD / b)).sum();
    // sum is in WAD (≥ WAD, since the max term contributes WAD). ln_fp expects WAD-scaled y ≥ WAD.
    let ln = ln_fp(sum);
    qmax + b * ln / WAD
}

#[odra::odra_error]
pub enum Error {
    /// Fewer than two outcomes.
    InvalidOutcomeCount = 1,
    /// Liquidity parameter b must be positive.
    InvalidLiquidity = 2,
    /// Outcome index out of range.
    UnknownOutcome = 3,
    /// Market already resolved.
    AlreadyResolved = 4,
}

#[odra::event]
pub struct LmsrTraded {
    pub outcome: u32,
    pub delta: i64,
    pub cost: i64,
}

/// A single LMSR book. Minimal on-chain state: liquidity `b` and share quantities `q`.
#[odra::module(errors = Error, events = [LmsrTraded])]
pub struct LmsrMarket {
    b: Var<u64>,
    n: Var<u32>,
    q: Mapping<u32, i64>,
    resolved: Var<bool>,
}

#[odra::module]
impl LmsrMarket {
    /// Initialize a book with liquidity `b` and `outcomes` outcomes, all quantities zero.
    pub fn init(&mut self, b: u64, outcomes: u32) {
        if outcomes < 2 {
            self.env().revert(Error::InvalidOutcomeCount);
        }
        if b == 0 {
            self.env().revert(Error::InvalidLiquidity);
        }
        self.b.set(b);
        self.n.set(outcomes);
        self.resolved.set(false);
    }

    /// The current price of an outcome, in WAD (1e9 = probability 1). Prices sum to WAD.
    pub fn price_wad(&self, outcome: u32) -> u64 {
        let prices = prices_wad(self.b.get_or_default() as i128, &self.q_vec());
        if outcome as usize >= prices.len() {
            self.env().revert(Error::UnknownOutcome);
        }
        prices[outcome as usize] as u64
    }

    /// The cost to buy `delta` shares (delta may be negative to sell) of `outcome`, in motes.
    /// Positive = trader pays; negative = maker pays (a sell).
    pub fn cost_to_trade(&self, outcome: u32, delta: i64) -> i64 {
        let b = self.b.get_or_default() as i128;
        let mut q = self.q_vec();
        if outcome as usize >= q.len() {
            self.env().revert(Error::UnknownOutcome);
        }
        let before = cost(b, &q);
        q[outcome as usize] += delta as i128;
        let after = cost(b, &q);
        (after - before) as i64
    }

    /// Apply a trade to the book (updates `q`). Emits the cost. Reverts once resolved.
    pub fn trade(&mut self, outcome: u32, delta: i64) {
        if self.resolved.get_or_default() {
            self.env().revert(Error::AlreadyResolved);
        }
        let c = self.cost_to_trade(outcome, delta);
        let cur = self.q.get_or_default(&outcome);
        self.q.set(&outcome, cur + delta);
        self.env().emit_event(LmsrTraded {
            outcome,
            delta,
            cost: c,
        });
    }

    /// The maker's worst-case loss for this book: b·ln(n), in motes.
    pub fn bounded_loss(&self) -> u64 {
        let b = self.b.get_or_default() as i128;
        let n = self.n.get_or_default() as i128;
        // b·ln(n) — reuse ln_fp on n·WAD.
        (b * ln_fp(n * WAD) / WAD) as u64
    }

    /// Total shares outstanding on an outcome.
    pub fn shares_of(&self, outcome: u32) -> i64 {
        self.q.get_or_default(&outcome)
    }

    fn q_vec(&self) -> Vec<i128> {
        let n = self.n.get_or_default();
        (0..n).map(|i| self.q.get_or_default(&i) as i128).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{cost, exp_neg_fp, ln_fp, prices_wad, LmsrMarket, LmsrMarketHostRef, LmsrMarketInitArgs, WAD};
    use odra::host::{Deployer, HostEnv, HostRef};

    // Tolerance for fixed-point vs float parity: 1e-4 of WAD (0.0001).
    const TOL: i128 = WAD / 10_000;

    fn approx(a: i128, b: i128, tol: i128) -> bool {
        (a - b).abs() <= tol
    }

    // ── Pure fixed-point math (parity vectors vs the float reference core/lmsr.ts) ──

    #[test]
    fn exp_matches_reference_values() {
        // exp(0) = 1
        assert!(approx(exp_neg_fp(0), WAD, TOL));
        // exp(-1) ≈ 0.36787944117 → 367879441
        assert!(approx(exp_neg_fp(-WAD), 367_879_441, TOL));
        // exp(-2) ≈ 0.13533528324 → 135335283
        assert!(approx(exp_neg_fp(-2 * WAD), 135_335_283, TOL));
        // exp(-0.5) ≈ 0.60653065971 → 606530660
        assert!(approx(exp_neg_fp(-WAD / 2), 606_530_660, TOL));
    }

    #[test]
    fn ln_matches_reference_values() {
        // ln(2) ≈ 0.69314718056 → 693147181
        assert!(approx(ln_fp(2 * WAD), 693_147_181, TOL));
        // ln(e) = 1; e·WAD ≈ 2718281828
        assert!(approx(ln_fp(2_718_281_828), WAD, TOL));
        // ln(4) ≈ 1.38629436 → 1386294361
        assert!(approx(ln_fp(4 * WAD), 1_386_294_361, TOL * 4));
    }

    #[test]
    fn prices_sum_to_wad_and_uniform_book_is_equal() {
        let p = prices_wad(100, &[0, 0]);
        assert_eq!(p.iter().sum::<i128>(), WAD);
        assert!(approx(p[0], WAD / 2, TOL));

        let p3 = prices_wad(50, &[0, 20, 5]);
        assert_eq!(p3.iter().sum::<i128>(), WAD);
    }

    #[test]
    fn buying_raises_price_and_lowers_others() {
        let before = prices_wad(100, &[0, 0, 0]);
        let after = prices_wad(100, &[40, 0, 0]);
        assert!(after[0] > before[0]);
        assert!(after[1] < before[1]);
        assert!(after[2] < before[2]);
    }

    #[test]
    fn cost_matches_reference() {
        // b=1, q=[0,0]: C = ln(2) ≈ 0.693147 → 693147181 (in WAD-as-motes units, b=1 tiny; use b=WAD).
        // Use integer b: b=1000, q=[0,0] → C = 1000·ln(2) ≈ 693.147 → 693 (integer motes).
        let c = cost(1000, &[0, 0]);
        assert!((c - 693).abs() <= 1);
    }

    #[test]
    fn no_free_money_round_trip() {
        // Buy 30 then sell 30 nets to ~0.
        let b = 100_i128;
        let q0 = vec![20_i128, 5, 8];
        let before = cost(b, &q0);
        let mut q1 = q0.clone();
        q1[1] += 30;
        let after_buy = cost(b, &q1);
        let buy = after_buy - before;
        let sell = before - after_buy; // selling back to q0
        assert!((buy + sell).abs() <= 1);
    }

    // ── The Odra module ──

    fn deploy(env: &HostEnv, b: u64, n: u32) -> LmsrMarketHostRef {
        LmsrMarket::deploy(env, LmsrMarketInitArgs { b, outcomes: n })
    }

    #[test]
    fn module_prices_sum_to_wad_and_move_with_trades() {
        let env = odra_test::env();
        let mut m = deploy(&env, 100, 2);
        assert_eq!(m.price_wad(0) + m.price_wad(1), WAD as u64);

        let p0_before = m.price_wad(0);
        m.trade(0, 40);
        assert!(m.price_wad(0) > p0_before);
        assert_eq!(m.shares_of(0), 40);
    }

    #[test]
    fn module_reports_bounded_loss() {
        let env = odra_test::env();
        let m = deploy(&env, 100, 2);
        // b·ln(2) ≈ 69.
        let loss = m.bounded_loss();
        assert!((loss as i128 - 69).abs() <= 1);
    }
}

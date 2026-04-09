/**
 * Challenge definition for Paradigm's Simple AMM.
 *
 * Source: https://www.optimizationarena.com/amm
 * Reference repo structure (may need to swap to official Paradigm repo tomorrow):
 *   https://github.com/benedictbrady/amm-challenge
 *
 * Mechanism:
 *   - Write Solidity Strategy inheriting AMMStrategyBase
 *   - Competes against normalizer AMM fixed at 30 bps
 *   - 10_000 steps per sim; price follows GBM
 *   - Score = Edge = retail profit - arb losses
 *
 * TODO tomorrow 8am PT: verify starter path and evaluator CLI against the
 * official repo once the hackathon problem drops.
 */

import type { ArenaChallenge, FailureSignal, SeedCapsule } from "../types.js";

export const simpleAmmChallenge: ArenaChallenge = {
  id: "simple-amm",
  name: "Simple AMM Fee Strategy (Paradigm)",
  language: "solidity",
  prompt: `Design a dynamic fee strategy for a constant-product AMM in Solidity.

YOUR FILE MUST START WITH EXACTLY THESE LINES (literal, verbatim):

  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.24;

  import {AMMStrategyBase} from "./AMMStrategyBase.sol";
  import {TradeInfo} from "./IAMMStrategy.sol";

  Do NOT change the import paths. Do NOT remove either import. The validator does a
  literal substring check for both "./AMMStrategyBase.sol" AND "./IAMMStrategy.sol".
  Missing either one causes immediate rejection before compilation.

YOUR CONTRACT must be named \`Strategy\` and inherit from \`AMMStrategyBase\`. It MUST implement:

  function afterInitialize(uint256 initialX, uint256 initialY)
      external override returns (uint256 bidFee, uint256 askFee);

  function afterSwap(TradeInfo calldata trade)
      external override returns (uint256 bidFee, uint256 askFee);

  function getName() external pure override returns (string memory);

CORE MECHANIC: you set a BUY fee (askFee) and a SELL fee (bidFee), and after every trade
you can change what fees you're showing the market. These two fees are INDEPENDENT — you can
be asymmetric (wider bid, tight ask) to capture directional flow.

TradeInfo fields available in afterSwap:
  - isBuy           (true if AMM bought X, i.e. trader sold X to you)
  - amountX, amountY (WAD precision, 1e18 = 1 unit)
  - timestamp       (step number, 0..9999)
  - reserveX, reserveY (post-trade reserves)

AVAILABLE HELPERS (inherited from AMMStrategyBase, DO NOT redefine):
    - Functions: wmul, wdiv, sqrt, clamp, clampFee, bpsToWad, wadToBps, absDiff, readSlot, writeSlot
    - Constants: WAD (=1e18), MAX_FEE (=1e17), MIN_FEE (=0), BPS (=1e14)
    - Storage: slots[0..31] (already declared as \`uint256[32] public slots\`)

  RESERVED NAMES — you MUST NOT declare constants, variables, or functions with these names because
  AMMStrategyBase already declares them: WAD, MAX_FEE, MIN_FEE, BPS, slots, wmul, wdiv, sqrt, clamp,
  clampFee, bpsToWad, wadToBps, absDiff, readSlot, writeSlot. Redeclaring any of them causes a
  DeclarationError at compile time.

  If you need a local minimum fee floor, name it something like \`MY_FEE_FLOOR\` or \`FLOOR_FEE\`, not
  \`MIN_FEE\`. If you need a max, use \`MY_FEE_CEILING\` not \`MAX_FEE\`. Prefix all your constants with
  something unique to avoid collisions.

  Fee values are in WAD: 1 bps = bpsToWad(1) = 1e14. 30 bps = bpsToWad(30) = 3e15. Max allowed = MAX_FEE = 1e17.

SIMULATION:
  - 10,000 steps per simulation, averaged over 1000 simulations
  - Fair price p follows GBM: S(t+1) = S(t) * exp(-σ²/2 + σZ), Z ~ N(0,1)
  - σ per-step ~ U[0.088%, 0.101%]
  - Retail orders Poisson(λ ~ U[0.6, 1.0]) orders/step, LogNormal size, 50/50 buy/sell
  - Retail flow splits optimally between your AMM and a fixed 30 bps normalizer AMM
  - Both start with (100 X, 10_000 Y) at price 100

SCORING: Edge = retail profit - arb losses, averaged over simulations.
The 30 bps normalizer typically scores 250-350 edge. You need to beat that.

REMEMBER:
  - Higher fees → arbs have to wait longer to profit → AMM stays "stale" longer → BAD for edge
  - Too-high fees → retail routes to normalizer → you get nothing
  - Static low fees bleed to arbs on volatility
  - Dynamic adaptation using TradeInfo is where edge comes from
  - Asymmetric bid/ask can capture directional imbalances

Return ONLY a complete Solidity file (contract Strategy). No markdown fences, no prose.`,

  systemContext: `You are a quantitative strategist writing Solidity AMM fee strategies for Paradigm's Simple AMM Challenge. You care about: (1) loss-vs-rebalancing to arbitrageurs, (2) retail edge capture via optimal routing, (3) volatility-adaptive fees using TradeInfo signals, (4) the competitive presence of a 30 bps normalizer, (5) exploiting asymmetric bid/ask spreads for directional flow. You write clean, gas-efficient, compilable Solidity 0.8.24. You use only the helpers provided by AMMStrategyBase (wmul, wdiv, sqrt, clampFee, bpsToWad, WAD, BPS). You always return a complete contract file that compiles.`,

  starterPath: "contracts/src/StarterStrategy.sol",
  solutionFileName: "contracts/src/Strategy.sol",

  // Normalizer (30 bps AMM) typically scores 250-350 edge per the Paradigm README.
  // We use 250 as the "are we even competitive?" floor — anything below triggers PCEC.
  baselineScoreReference: 250,

  // The official challenge uses a Python CLI `amm-match` (backed by a Rust sim engine).
  // Setup: cd amm_sim_rs && maturin develop --release && cd .. && pip install -e .
  // Run:   amm-match run <solution.sol> --simulations N
  // For dev loop we use --simulations 100 for speed; bump to 1000 for final eval.
  evaluatorCommand: (solutionPath, _seed) =>
    `amm-match run "${solutionPath}" --simulations 100`,

  parseScore: (stdout: string): number => {
    // amm-match output format (VERIFIED against real amm-match run on 2026-04-09):
    //   "StarterStrategy Edge: 392.08"
    // Format is: "<StrategyName> Edge: <number>" — single line, no "Average" or "Mean".
    // We use \b to anchor on word boundary and avoid accidentally matching prose.
    const patterns = [
      /\bEdge:\s+(-?[\d.]+)/i,                  // primary: "Edge: 392.08"
      /\bedge[:\s]+(-?[\d.]+)/i,                // fallback: any "edge" line
      /\bscore[:\s]+(-?[\d.]+)/i,               // fallback: "score: N"
    ];
    for (const p of patterns) {
      const m = stdout.match(p);
      if (m) return parseFloat(m[1]);
    }
    return Number.NEGATIVE_INFINITY;
  },

  parseFailures: (stdout: string): FailureSignal[] => {
    const failures: FailureSignal[] = [];

    // Validation / compile failure (amm-match validate surfaces these)
    if (/(Validation failed|ValidationError|CompileError|Error:|error\[)/i.test(stdout) && !/0\s+errors/i.test(stdout)) {
      failures.push({
        category: "compile-error",
        message: extractCompileError(stdout),
        severity: 1.0,
        evidence: { raw: stdout.slice(0, 500) },
      });
      return failures;
    }

    // Look for edge being suspiciously low (below normalizer typical range)
    const edgeMatch = stdout.match(/\bEdge:\s+(-?[\d.]+)/i);
    if (edgeMatch) {
      const edge = parseFloat(edgeMatch[1]);
      // Normalizer typically scores 250-350; anything below 200 is "underperforming the reference"
      if (edge < 200) {
        failures.push({
          category: "underperforms-normalizer",
          message: `Edge ${edge.toFixed(1)} is below the 30 bps normalizer's typical range (250-350)`,
          severity: 0.7,
          evidence: { edge, normalizerRange: [250, 350] },
        });
      }
      if (edge < 0) {
        failures.push({
          category: "negative-edge",
          message: `Edge is negative (${edge.toFixed(1)}) — strategy is losing money on average`,
          severity: 0.9,
          evidence: { edge },
        });
      }
    }

    return failures;
  },
};

function extractCompileError(stdout: string): string {
  // Match "Validation failed:" followed by indented bullet lines
  const validationMatch = stdout.match(/Validation failed:\s*(?:\n\s*-[^\n]+){1,5}/);
  if (validationMatch) return validationMatch[0].slice(0, 400);
  // Fall back to generic Error line match
  const match = stdout.match(/Error[^\n]*\n[^\n]*/);
  return match ? match[0].slice(0, 200) : "Unknown compile error";
}

// ============================================================================
// Seed Gene Capsules — pre-loaded knowledge for Simple AMM
// ============================================================================

/**
 * Pre-loaded capsules from general AMM design principles. These are the 9 seed
 * entries the Gene Map starts with — during the hackathon we live-learn additional
 * capsules from observed failures. The honest story: "we seeded 9 capsules from
 * well-known AMM patterns; everything above 9 was learned today."
 */
export const ammSeedCapsules: SeedCapsule[] = [
  {
    id: "amm-seed-001",
    trigger: { category: "underperforms-normalizer" },
    repair: {
      strategy: "Lower both bidFee and askFee toward 25-30 bps. The 30 bps normalizer is the competitive ceiling — any static fees above it route retail away. Start with bpsToWad(28) for both and iterate from there.",
      rationale: "Retail routing is non-linear in fee differential; even 2-5 bps above normalizer drives most volume away and drops edge below the ~250 reference.",
    },
    tokenCost: 180,
    source: "seed",
    confidence: 0.85,
  },
  {
    id: "amm-seed-002",
    trigger: { category: "negative-edge" },
    repair: {
      strategy: "Widen fees on the side that was just hit by a large arb trade. If trade.amountY / trade.reserveY > 5%, treat as likely-arb and bump the fee on the same side by 10 bps. Decay back toward 30 bps over subsequent trades when sizes are normal.",
      rationale: "Arbs front-run price moves with large impact trades; a post-trade fee spike on the hit side taxes follow-on arb without affecting retail that arrives between spikes.",
    },
    tokenCost: 220,
    source: "seed",
    confidence: 0.82,
  },
  {
    id: "amm-seed-003",
    trigger: { category: "plateau" },
    repair: {
      strategy: "Use slots[0] and slots[1] to track an EWMA of |log(reserveY/reserveX)| returns — a realized-volatility proxy. Scale both bidFee and askFee proportionally to this EWMA with floor bpsToWad(15) and ceiling bpsToWad(60). Volatile regime → wider fees; calm regime → tighter.",
      rationale: "Static strategies plateau because they cannot distinguish calm from volatile regimes. A simple volatility EWMA over recent trades is the smallest useful state that breaks the plateau.",
    },
    tokenCost: 280,
    source: "seed",
    confidence: 0.78,
  },
  {
    id: "amm-seed-004",
    trigger: { category: "compile-error" },
    repair: {
      strategy: "The file MUST contain both literal strings './AMMStrategyBase.sol' AND './IAMMStrategy.sol' as import paths — the validator does a substring check, not a compile check. Required imports (copy verbatim): `import {AMMStrategyBase} from \"./AMMStrategyBase.sol\";` and `import {TradeInfo} from \"./IAMMStrategy.sol\";`. Both are mandatory even if TradeInfo appears unused in your strategy. Then: contract name exactly 'Strategy', all methods have `external override`, afterInitialize and afterSwap return TWO uint256 values (bidFee, askFee), getName() returns (string memory), pragma ^0.8.24.",
      rationale: "The most common compile failures are missing getName(), wrong return arity (one value instead of two), missing override keyword, and wrong import paths.",
    },
    tokenCost: 140,
    source: "seed",
    confidence: 0.95,
  },
  {
    id: "amm-seed-005",
    trigger: { category: "simple-amm:underperforms-normalizer" },
    repair: {
      strategy: "Check whether your strategy even reads TradeInfo. Purely static fee strategies cannot beat the normalizer because the normalizer is also static and fees in the same range trade identical edge. You must read trade.amountX, trade.amountY, trade.isBuy, or compute price impact from trade.reserveX/trade.reserveY to adapt.",
      rationale: "The normalizer is a 30 bps Schelling point. Any static strategy is dominated by it in expectation. You need trade-conditional behavior to generate edge above ~250.",
    },
    tokenCost: 210,
    source: "seed",
    confidence: 0.88,
  },
  {
    id: "amm-seed-006",
    trigger: { category: "simple-amm:underperforms-normalizer", conditions: { secondaryFailure: "ignores-state" } },
    repair: {
      strategy: "Use slots[0] to store the last trade's size ratio (amountY / reserveY in WAD), slots[1] to store an EWMA of that. In afterSwap, compute size_anomaly = current_ratio / ewma. Set fee = wmul(bpsToWad(30), WAD + (size_anomaly - WAD) / 4). This increases fees proportionally when recent flow is anomalously large (likely arb) and relaxes during retail-dominated periods.",
      rationale: "Two-dimensional state (current impact + recent baseline) captures both informed-flow signal and volume regime in minimal storage.",
    },
    tokenCost: 320,
    source: "seed",
    confidence: 0.75,
  },
  {
    id: "amm-seed-007",
    trigger: { category: "plateau", conditions: { iteration: { $gt: 15 } } },
    repair: {
      strategy: "Switch exploration mode: introduce ASYMMETRIC bid/ask fees. If last trade was a buy (trade.isBuy == false, AMM sold X), the market is taking X from you at this price — widen askFee more than bidFee. If last trade was a sell, widen bidFee more. Start with +5 bps differential and tune. This exploits directional flow that symmetric strategies ignore.",
      rationale: "Late-stage plateaus often mean the symmetric fee family has been exhausted; bid/ask asymmetry is a structurally new dimension that opens fresh edge.",
    },
    tokenCost: 260,
    source: "seed",
    confidence: 0.72,
  },
  {
    id: "amm-seed-008",
    trigger: { category: "underperforms-normalizer", conditions: { secondaryFailure: "fees-too-high" } },
    repair: {
      strategy: "Hard rule: do not return fees above bpsToWad(35). The 30 bps normalizer creates a hard routing ceiling at ~30 bps. Strategies that return fees in the 50+ bps range (like the starter's 50 bps) lose almost all retail flow. Use clampFee(fee) to bound your output below 35 bps as a safety rail.",
      rationale: "The normalizer AMM creates a hard upper bound on competitive fees. Strategies that return 40-50 bps lose retail flow immediately and score far below normalizer's own ~250-350 range.",
    },
    tokenCost: 150,
    source: "seed",
    confidence: 0.9,
  },
  {
    id: "amm-seed-009",
    trigger: { category: "simple-amm:negative-edge", conditions: { hint: "asymmetry" } },
    repair: {
      strategy: "The bid/ask split lets you price inventory risk directly. If slots[0] tracks (reserveX - initialX), positive means you've accumulated X → widen askFee to discourage further X buys from traders (which dump more X on you) and tighten bidFee to encourage rebalancing sells. Mirror for negative. This is a classic market-maker inventory-skew pattern ported to the AMM setting.",
      rationale: "Inventory skew is the canonical market-making primitive. The Simple AMM's bid/ask asymmetry makes this directly expressible — most single-fee strategies leave this edge on the table.",
    },
    tokenCost: 290,
    source: "seed",
    confidence: 0.74,
  },
  {
    id: "amm-seed-010",
    trigger: { category: "compile-error", conditions: { hint: "declaration-conflict" } },
    repair: {
      strategy: "Do NOT declare constants named MIN_FEE, MAX_FEE, WAD, or BPS — these are inherited from AMMStrategyBase as `public constant`. Redeclaring them causes `DeclarationError: Identifier already declared`. Also do not shadow these function names: wmul, wdiv, sqrt, clamp, clampFee, bpsToWad, wadToBps, absDiff, readSlot, writeSlot. If you need your own floor/ceiling, prefix them (e.g. MY_FLOOR, LOCAL_MAX). Also do not redeclare the `slots` variable — it already exists as `uint256[32] public slots` in the base.",
      rationale: "The most common second-order compile error after fixing imports is shadowing AMMStrategyBase constants. The base contract declares MIN_FEE=0, MAX_FEE=1e17, WAD=1e18, BPS=1e14 as public constants; any user redeclaration breaks Solidity's identifier resolution.",
    },
    tokenCost: 180,
    source: "seed",
    confidence: 0.92,
  },
];

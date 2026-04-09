/**
 * @vial-agent/adapter-optimization-arena
 *
 * Translation layer between Paradigm's Optimization Arena and the domain-agnostic
 * Vial runtime. All arena-specific terminology (Solidity, fees, Edge, Strategy)
 * lives here and NOWHERE ELSE. The runtime sees only:
 *   - generic "candidate solutions"
 *   - generic "score deltas"
 *   - generic "failure events"
 *
 * This preserves the grep discipline: zero arena-specific terms in @vial-agent/runtime.
 */

// ============================================================================
// Arena concepts (stay in this package only)
// ============================================================================

export interface ArenaChallenge {
  /** Unique slug, e.g. "simple-amm", "prop-amm", "persuasion" */
  id: string;
  /** Human name */
  name: string;
  /** What language the solution is written in */
  language: "solidity" | "rust" | "python" | "text" | "onnx" | "json";
  /** Short description shown to the LLM when generating candidates */
  prompt: string;
  /** System prompt context injected into every generation call */
  systemContext: string;
  /** Path (relative to challenge dir) of the starter file */
  starterPath: string;
  /**
   * File name (relative to challenge-repo root) where the runner writes each
   * candidate solution. For Simple AMM this is "contracts/src/Strategy.sol".
   * For Persuasion it's "candidate.txt". This replaces the old StarterStrategy
   * string-replacement hack.
   */
  solutionFileName: string;
  /** Command that runs the local evaluator and returns a score */
  evaluatorCommand: (solutionPath: string, seed: number) => string;
  /** Parses evaluator stdout into a numeric score (higher = better) */
  parseScore: (stdout: string) => number;
  /** Optional: parses evaluator stdout into a structured failure signal */
  parseFailures?: (stdout: string) => FailureSignal[];
  /**
   * Reference score for "are we even competitive?" detection. For Simple AMM this
   * is the ~250 edge the 30 bps normalizer scores. Candidates below this threshold
   * trigger a synthesized `score-below-baseline` failure that feeds PCEC.
   */
  baselineScoreReference: number;
}

export interface CandidateSolution {
  /** Generation iteration (0-indexed) */
  iteration: number;
  /** Source code of the candidate */
  code: string;
  /** Evaluator score (higher = better) */
  score: number;
  /** Baseline score (e.g. normalizer AMM, fixed 30 bps) — for delta calculation */
  baselineScore: number;
  /** Structured failure signals parsed from evaluator output */
  failures: FailureSignal[];
  /** Which gene capsules (if any) conditioned this generation */
  appliedCapsules: string[];
  /** Wall-clock seconds spent in LLM generation */
  generationMs: number;
  /** Wall-clock seconds spent in evaluation */
  evaluationMs: number;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * A failure signal is the arena-layer concept. We translate these into generic
 * "perceived errors" before handing them to the Vial runtime.
 */
export interface FailureSignal {
  /** Category of failure, e.g. "fee-too-high", "fee-too-low", "ignores-volatility" */
  category: string;
  /** Specific diagnostic message from the evaluator or post-hoc analysis */
  message: string;
  /** Severity in [0, 1] where 1 = catastrophic */
  severity: number;
  /** Optional: structured evidence (e.g. retail flow routed away percentage) */
  evidence?: Record<string, unknown>;
}

// ============================================================================
// Translation: Arena → Vial runtime
// ============================================================================

/**
 * The Vial runtime sees these generic concepts. Note the absence of ANY
 * arena-specific terms — this mirror type lives here purely as documentation
 * of the interface we'll call into @vial-agent/runtime with.
 */
export interface GenericPerceivedFailure {
  /** Abstract category — runtime doesn't know what it means */
  category: string;
  /** Severity [0, 1] */
  severity: number;
  /** Free-form context the runtime will pass through to PCEC */
  context: Record<string, unknown>;
  /** Timestamp for Gene Map temporal queries */
  at: string;
}

/**
 * Translate arena failures into the runtime's generic shape. This is the ONLY
 * function that should call into @vial-agent/runtime, keeping the rest of the
 * adapter purely in arena-space.
 */
export function toGenericFailure(
  challenge: ArenaChallenge,
  failure: FailureSignal,
  candidate: CandidateSolution,
): GenericPerceivedFailure {
  return {
    category: `${challenge.id}:${failure.category}`,
    severity: failure.severity,
    context: {
      challengeId: challenge.id,
      language: challenge.language,
      iteration: candidate.iteration,
      score: candidate.score,
      baselineScore: candidate.baselineScore,
      scoreDelta: candidate.score - candidate.baselineScore,
      diagnostic: failure.message,
      evidence: failure.evidence ?? {},
    },
    at: candidate.timestamp,
  };
}

/**
 * Synthesize a failure signal from a score-below-baseline observation.
 * This is the "PCEC for optimization" trick: the runtime was built around
 * explicit errors, but here we manufacture a synthetic error event whenever
 * the candidate underperforms the baseline. The semantics are preserved —
 * "perceived failure" just means "something measurable went wrong," and a low
 * score IS something measurable going wrong.
 */
export function synthesizeScoreFailure(
  candidate: CandidateSolution,
  threshold = 0,
): FailureSignal | null {
  const delta = candidate.score - candidate.baselineScore;
  if (delta >= threshold) return null;
  // Map delta to [0, 1] severity. A 50% underperformance → severity 1.
  const severity = Math.min(1, Math.abs(delta) / Math.max(1, Math.abs(candidate.baselineScore) * 0.5));
  return {
    category: "score-below-baseline",
    message: `Score ${candidate.score.toFixed(3)} < baseline ${candidate.baselineScore.toFixed(3)} (delta ${delta.toFixed(3)})`,
    severity,
    evidence: {
      score: candidate.score,
      baseline: candidate.baselineScore,
      delta,
      iteration: candidate.iteration,
    },
  };
}

/**
 * Plateau detection: if the last N iterations haven't improved, that's ALSO
 * a perceived failure — "we're stuck." The runtime will use this to trigger
 * exploration strategies in the Gene Map (rather than exploiting known-good
 * capsules).
 */
export function synthesizePlateauFailure(
  history: CandidateSolution[],
  window = 5,
  minImprovement = 0.01,
): FailureSignal | null {
  if (history.length < window) return null;
  const recent = history.slice(-window);
  const best = Math.max(...recent.map((c) => c.score));
  const worst = Math.min(...recent.map((c) => c.score));
  const spread = best - worst;
  if (spread >= minImprovement * Math.max(1, Math.abs(best))) return null;
  return {
    category: "plateau",
    message: `No meaningful improvement in last ${window} iterations (spread ${spread.toFixed(4)})`,
    severity: 0.6,
    evidence: {
      window,
      best,
      worst,
      spread,
      recentScores: recent.map((c) => c.score),
    },
  };
}

// ============================================================================
// Gene Capsule — generic repair strategy persisted in the Gene Map
// ============================================================================

/**
 * A Gene Capsule is a (trigger, repair) pair learned or seeded into the Gene Map.
 * During generation, relevant capsules are retrieved and injected into the LLM
 * prompt as conditioning context. During PCEC commit, new capsules are
 * synthesized from (failure signal, successful repair) pairs.
 *
 * Intentionally generic — the trigger.category is an opaque string that each
 * challenge adapter defines. The runtime does not interpret it.
 */
export interface SeedCapsule {
  id: string;
  trigger: {
    category: string;
    conditions?: Record<string, unknown>;
  };
  repair: {
    strategy: string;
    rationale: string;
  };
  tokenCost: number;
  source: "seed" | "learned" | "llm";
  confidence: number;
}

/**
 * Main meta-loop runner.
 *
 * Two modes:
 *   --mode baseline   Naive LLM loop: generate → evaluate → repeat. No memory.
 *   --mode vial       Vial-wrapped loop: generate → evaluate → PCEC → Gene Map → repeat.
 *   --mode ab         Runs both sequentially with identical seeds for direct comparison.
 *
 * This is the entire demo. Everything else is plumbing.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execa } from "execa";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { simpleAmmChallenge, ammSeedCapsules } from "./challenges/simple-amm.js";
import { persuasionChallenge, persuasionSeedCapsules } from "./challenges/persuasion.js";

const CHALLENGE_REGISTRY: Record<string, { challenge: ArenaChallenge; seedCapsules: SeedCapsule[] }> = {
  "simple-amm": { challenge: simpleAmmChallenge, seedCapsules: ammSeedCapsules },
  "persuasion": { challenge: persuasionChallenge, seedCapsules: persuasionSeedCapsules },
};
import { GeneMap } from "./gene-map.js";
import type { ArenaChallenge, CandidateSolution, FailureSignal, SeedCapsule } from "./types.js";
import { synthesizeScoreFailure, synthesizePlateauFailure } from "./types.js";

interface RunConfig {
  mode: "baseline" | "vial" | "ab";
  challenge: ArenaChallenge;
  iterations: number;
  workDir: string;
  challengeRepoPath: string; // local clone of the Paradigm challenge repo
  seed: number;
  dashboardPath?: string; // JSON file written after each iteration for live dashboard
}

const anthropic = new Anthropic();
const MODEL = "claude-sonnet-4-5-20250929";

// ============================================================================
// LLM generation
// ============================================================================

async function generateBaseline(
  challenge: ArenaChallenge,
  history: CandidateSolution[],
): Promise<{ code: string; tokenCost: number }> {
  const previousAttempts = history.slice(-3).map((c) =>
    `// Iteration ${c.iteration}, score ${c.score.toFixed(3)}:\n${c.code}`
  ).join("\n\n---\n\n");

  const userPrompt = previousAttempts
    ? `${challenge.prompt}\n\nPrevious attempts (newest last):\n\n${previousAttempts}\n\nProduce an improved strategy.`
    : challenge.prompt;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: challenge.systemContext,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return {
    code: extractCode(text),
    tokenCost: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
  };
}

async function generateWithVial(
  challenge: ArenaChallenge,
  history: CandidateSolution[],
  geneMap: GeneMap,
  activeFailures: FailureSignal[],
): Promise<{ code: string; tokenCost: number; appliedCapsuleIds: string[] }> {
  // PCEC: Perceive → Construct → Evaluate → Commit
  // Construct phase is two-tiered:
  //   (a) Ambient priors: top-K highest-confidence capsules injected as standing guidance
  //   (b) Failure-triggered: additional capsules targeting specific observed failure categories
  const capsules: any[] = [];

  // (a) Ambient priors — always pull the top-3 highest-confidence capsules.
  // This ensures the Gene Map informs EVERY generation, not just failure repairs.
  const ambientPriors = geneMap.getAllCapsules().slice(0, 3);
  for (const c of ambientPriors) capsules.push(c);

  // (b) Failure-triggered capsules — stack on top of priors.
  for (const f of activeFailures) {
    const qualified = `${challenge.id}:${f.category}`;
    const found = [
      ...geneMap.findCapsules(qualified, 2),
      ...geneMap.findCapsules(f.category, 2),
    ];
    for (const c of found) {
      if (!capsules.find((existing) => existing.id === c.id)) capsules.push(c);
    }
  }

  const capsuleBlock =
    capsules.length > 0
      ? `Relevant repair strategies from the Gene Map (apply as appropriate):
${capsules
  .map(
    (c, i) =>
      `${i + 1}. [trigger: ${c.trigger.category}, confidence ${c.confidence.toFixed(2)}, hits ${c.hitCount}]
   Strategy: ${c.repair.strategy}
   Rationale: ${c.repair.rationale}`,
  )
  .join("\n\n")}

`
      : "";

  const failureBlock =
    activeFailures.length > 0
      ? `Observed failures from the last iteration:
${activeFailures.map((f) => `- [${f.category}, severity ${f.severity.toFixed(2)}] ${f.message}`).join("\n")}

`
      : "";

  const previousBest =
    history.length > 0
      ? `Best prior attempt (score ${[...history].sort((a, b) => b.score - a.score)[0].score.toFixed(3)}):
${[...history].sort((a, b) => b.score - a.score)[0].code}

`
      : "";

  const userPrompt = `${challenge.prompt}

${failureBlock}${capsuleBlock}${previousBest}Produce an improved strategy that addresses the observed failures using the repair strategies above where applicable. Return only the ${challenge.language} source, no prose.`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: challenge.systemContext,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return {
    code: extractCode(text),
    tokenCost: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
    appliedCapsuleIds: capsules.map((c) => c.id),
  };
}

function extractCode(text: string): string {
  // Strip markdown fences of any language
  const fenced = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

// ============================================================================
// Local evaluation (wraps the challenge's local CLI harness)
// ============================================================================

async function evaluate(
  challenge: ArenaChallenge,
  code: string,
  workDir: string,
  challengeRepoPath: string,
  seed: number,
): Promise<{ score: number; failures: FailureSignal[]; evaluationMs: number; raw: string }> {
  const solutionPath = join(challengeRepoPath, challenge.solutionFileName);
  await writeFile(solutionPath, code, "utf8");

  const start = Date.now();
  let stdout = "";
  let stderr = "";
  try {
    const result = await execa("sh", ["-c", challenge.evaluatorCommand(solutionPath, seed)], {
      cwd: challengeRepoPath,
      reject: false,
      timeout: 120_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e: any) {
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? String(e);
  }

  const combined = stdout + "\n" + stderr;
  const score = challenge.parseScore(combined);
  const failures = challenge.parseFailures?.(combined) ?? [];
  return { score, failures, evaluationMs: Date.now() - start, raw: combined };
}

// ============================================================================
// Meta-loop
// ============================================================================

async function runLoop(
  mode: "baseline" | "vial",
  config: RunConfig,
  runId: string,
  sharedState: SharedDashboardState,
) {
  const { challenge, iterations, workDir, challengeRepoPath, seed } = config;
  const geneMap = new GeneMap(join(workDir, `${runId}-${mode}.db`));

  if (mode === "vial") {
    const seedCapsules = CHALLENGE_REGISTRY[challenge.id]?.seedCapsules ?? [];
    for (const capsule of seedCapsules) geneMap.upsertCapsule(capsule);
    console.log(`[${mode}] Seeded ${seedCapsules.length} capsules`);
  }

  const history: CandidateSolution[] = [];
  const BASELINE_SCORE = challenge.baselineScoreReference;

  for (let i = 0; i < iterations; i++) {
    const iterStart = Date.now();

    // ---- Construct active failure set (PCEC "Perceive") ----
    const lastCandidate = history[history.length - 1];
    const activeFailures: FailureSignal[] = [];
    if (lastCandidate) {
      activeFailures.push(...lastCandidate.failures);
      const scoreFailure = synthesizeScoreFailure(lastCandidate, BASELINE_SCORE);
      if (scoreFailure) activeFailures.push(scoreFailure);
      const plateauFailure = synthesizePlateauFailure(history);
      if (plateauFailure) activeFailures.push(plateauFailure);
    }

    // ---- Generate (PCEC "Construct") ----
    const genStart = Date.now();
    let code: string;
    let tokenCost: number;
    let appliedCapsuleIds: string[] = [];
    if (mode === "baseline") {
      ({ code, tokenCost } = await generateBaseline(challenge, history));
    } else {
      ({ code, tokenCost, appliedCapsuleIds } = await generateWithVial(
        challenge,
        history,
        geneMap,
        activeFailures,
      ));
    }
    const generationMs = Date.now() - genStart;

    // ---- Evaluate ----
    const { score, failures, evaluationMs } = await evaluate(
      challenge,
      code,
      workDir,
      challengeRepoPath,
      seed + i,
    );

    const candidate: CandidateSolution = {
      iteration: i,
      code,
      score,
      baselineScore: BASELINE_SCORE,
      failures,
      appliedCapsules: appliedCapsuleIds,
      generationMs,
      evaluationMs,
      timestamp: new Date().toISOString(),
    };
    history.push(candidate);

    // ---- Commit (PCEC "Commit") — only in vial mode ----
    if (mode === "vial") {
      // Find the most recent FINITE previous score to compare against.
      // If none exists (e.g. all prior iterations were compile failures),
      // fall back to the challenge's baseline reference.
      const prevFiniteCandidate = [...history.slice(0, -1)]
        .reverse()
        .find((c) => Number.isFinite(c.score));
      const prevScore = prevFiniteCandidate?.score ?? BASELINE_SCORE;

      // Sanitize scoreDelta: if current score isn't finite, there's no learning signal.
      const rawDelta = score - prevScore;
      const scoreDelta = Number.isFinite(rawDelta) ? rawDelta : 0;
      const canLearn = Number.isFinite(score);

      // Record hits on applied capsules (even on failures — they tried and failed, that's signal)
      for (const capsuleId of appliedCapsuleIds) geneMap.recordHit(capsuleId, scoreDelta);

      // Synthesize a new capsule only if (a) score is finite, (b) improved, (c) had failures to learn from
      if (canLearn && scoreDelta > 0 && activeFailures.length > 0) {
        const topFailure = activeFailures.sort((a, b) => b.severity - a.severity)[0];
        const newId = geneMap.learnCapsule(
          `${challenge.id}:${topFailure.category}`,
          `Approach that improved score from ${prevScore.toFixed(2)} to ${score.toFixed(2)}: ${summarizeStrategy(code)}`,
          `Discovered during hackathon iteration ${i}; gained ${scoreDelta.toFixed(2)} edge over prior attempt.`,
          scoreDelta,
          tokenCost,
        );
        console.log(`[${mode}] iter ${i}: learned capsule ${newId} (+${scoreDelta.toFixed(2)})`);
      }
    }

    geneMap.recordIteration({
      runId,
      mode,
      iteration: i,
      score,
      baselineScore: BASELINE_SCORE,
      appliedCapsules: appliedCapsuleIds,
      failureCategories: failures.map((f) => f.category),
      generationMs,
      evaluationMs,
      code,
      timestamp: candidate.timestamp,
    });

    const logPrevScore = history[history.length - 2]?.score;
    const logDelta = Number.isFinite(score) && Number.isFinite(logPrevScore ?? NaN)
      ? (score - (logPrevScore as number)).toFixed(3)
      : "n/a";
    console.log(
      `[${mode}] iter ${i}: score=${Number.isFinite(score) ? score.toFixed(3) : "FAIL"} (Δ ${logDelta}) ` +
        `failures=[${failures.map((f) => f.category).join(",")}] ` +
        `capsules=[${appliedCapsuleIds.length}] ` +
        `${((Date.now() - iterStart) / 1000).toFixed(1)}s`,
    );

    // ---- Update shared state for dashboard ----
    const sharedEntry = {
      iteration: i,
      score,
      appliedCapsules: appliedCapsuleIds,
      failureCategories: failures.map((f) => f.category),
    };
    if (mode === "baseline") {
      sharedState.historyBaseline.push(sharedEntry);
    } else {
      sharedState.historyVial.push(sharedEntry);
    }
    sharedState.capsules = geneMap.getAllCapsules().map((c) => ({
      id: c.id,
      trigger: c.trigger.category,
      source: c.source,
      confidence: c.confidence,
      hitCount: c.hitCount,
      totalScoreDelta: c.totalScoreDelta,
    }));
    if (config.dashboardPath) {
      await writeDashboardState(config.dashboardPath, runId, sharedState);
    }
  }

  geneMap.close();
  return history;
}

function summarizeStrategy(code: string): string {
  // Crude summary: extract function bodies and key constants
  const fees = [...code.matchAll(/bpsToWad\((\d+)\)/g)].map((m) => m[1]);
  const hasState = /slots\[\d+\]/.test(code);
  const hasAfterSwapLogic = /afterSwap[^{]*\{[\s\S]{100,}/.test(code);
  return `fees=${fees.join(",")} stateful=${hasState} adaptive=${hasAfterSwapLogic}`;
}

interface SharedDashboardState {
  historyBaseline: Array<{
    iteration: number;
    score: number;
    appliedCapsules: string[];
    failureCategories: string[];
  }>;
  historyVial: Array<{
    iteration: number;
    score: number;
    appliedCapsules: string[];
    failureCategories: string[];
  }>;
  capsules: Array<{
    id: string;
    trigger: string;
    source: string;
    confidence: number;
    hitCount: number;
    totalScoreDelta: number;
  }>;
}

async function writeDashboardState(
  path: string,
  runId: string,
  sharedState: SharedDashboardState,
) {
  const state = {
    runId,
    mode: "ab",
    lastUpdate: new Date().toISOString(),
    historyBaseline: sharedState.historyBaseline,
    historyVial: sharedState.historyVial,
    capsules: sharedState.capsules,
  };
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };

  const challengeSlug = get("--challenge", "simple-amm");
  const registryEntry = CHALLENGE_REGISTRY[challengeSlug];
  if (!registryEntry) {
    console.error(`\n❌ Unknown challenge: ${challengeSlug}`);
    console.error(`   Available: ${Object.keys(CHALLENGE_REGISTRY).join(", ")}\n`);
    process.exit(1);
  }

  const config: RunConfig = {
    mode: get("--mode", "ab") as any,
    challenge: registryEntry.challenge,
    iterations: parseInt(get("--iterations", "20"), 10),
    workDir: resolve(get("--workdir", "./work")),
    challengeRepoPath: resolve(get("--challenge-repo", "./amm-challenge")),
    seed: parseInt(get("--seed", "42"), 10),
    dashboardPath: resolve(get("--dashboard", "./dashboard-state.json")),
  };

  if (!existsSync(config.workDir)) await mkdir(config.workDir, { recursive: true });
  if (!existsSync(config.challengeRepoPath)) {
    console.error(`\n❌ Challenge repo not found at ${config.challengeRepoPath}`);
    console.error(`   Clone the Paradigm Simple AMM repo first:`);
    console.error(`   git clone https://github.com/<paradigm-org>/amm-challenge.git\n`);
    process.exit(1);
  }

  const runId = randomUUID().slice(0, 8);
  console.log(`\n🧬 Vial × Optimization Arena — run ${runId}`);
  console.log(`   mode=${config.mode} iterations=${config.iterations} seed=${config.seed}\n`);

  const sharedState: SharedDashboardState = {
    historyBaseline: [],
    historyVial: [],
    capsules: [],
  };

  if (config.mode === "ab") {
    console.log("─── BASELINE (naive LLM loop) ───");
    const baseline = await runLoop("baseline", config, runId, sharedState);
    console.log("\n─── VIAL (PCEC + Gene Map) ───");
    const vial = await runLoop("vial", config, runId, sharedState);

    const finiteB = baseline.map((c) => c.score).filter((s) => Number.isFinite(s));
    const finiteV = vial.map((c) => c.score).filter((s) => Number.isFinite(s));
    const bBest = finiteB.length ? Math.max(...finiteB) : Number.NEGATIVE_INFINITY;
    const vBest = finiteV.length ? Math.max(...finiteV) : Number.NEGATIVE_INFINITY;
    console.log(`\n═══ RESULTS ═══`);
    console.log(`Baseline best:  ${Number.isFinite(bBest) ? bBest.toFixed(3) : "none"}`);
    console.log(`Vial best:      ${Number.isFinite(vBest) ? vBest.toFixed(3) : "none"}`);
    if (Number.isFinite(bBest) && Number.isFinite(vBest)) {
      console.log(`Improvement:    ${(((vBest - bBest) / Math.max(1, Math.abs(bBest))) * 100).toFixed(1)}%`);
    }
    const bFails = baseline.filter((c) => !Number.isFinite(c.score)).length;
    const vFails = vial.filter((c) => !Number.isFinite(c.score)).length;
    console.log(`Compile fails:  baseline=${bFails}/${baseline.length}  vial=${vFails}/${vial.length}`);
  } else {
    await runLoop(config.mode, config, runId, sharedState);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Challenge definition for Paradigm's Persuasion challenge.
 *
 * Source: https://www.optimizationarena.com/persuasion
 * Task: Write a 140-character description of a pen to maximize how much
 *       15 diverse AI buyers would pay. Score = median price in USD.
 *
 * Note: Paradigm does NOT ship a local harness for this challenge. We built
 * our own mock evaluator (~/Projects/persuasion-challenge/eval.py) that
 * uses 5 Haiku-played personas instead of 15 (5x cheaper for rehearsal).
 * The mock is structurally identical — it reads a candidate file, runs LLM
 * judges, prints "Median price: N.NN".
 */

import type { ArenaChallenge, FailureSignal, SeedCapsule } from "../types.js";

export const persuasionChallenge: ArenaChallenge = {
  id: "persuasion",
  name: "Persuasion (Pen description)",
  language: "text",

  prompt: `Write a description of a pen that maximizes how much diverse AI buyer personas would pay for it.

HARD CONSTRAINT: The description MUST be 140 characters or fewer. Count carefully including spaces and punctuation. Exceeding 140 causes immediate rejection by the validator — you get zero score.

SCORING: 5 distinct buyer personas read your description and each states a USD price. Final score is the MEDIAN of their 5 prices. The personas are:
  1. Budget Student — frugal, skeptical, rejects puffery, looks for practical value
  2. Wealthy Collector — values craftsmanship, exclusivity, heritage; money is no object
  3. Pragmatic Engineer — values function per dollar, durability, distrusts status signaling
  4. Minimalist Designer — values restraint, material quality, understated elegance; refuses ornament
  5. Tech Gadget Enthusiast — early adopter, pays premium for innovation and novel features

KEY INSIGHT: The median rewards descriptions that reach the MIDDLE of the price distribution, not the extremes. A description that makes the Collector pay $2000 but gets $0 from the Student and Engineer will have median around $50, not $2000. You want ALL 5 personas to pay something meaningful.

TRADE-OFFS:
  - Pure luxury language ("handcrafted", "gold-plated", "limited edition") → wins Collector + Designer, loses Student
  - Pure practicality ("durable", "reliable", "ergonomic") → wins Engineer + Student, bores Collector
  - Pure novelty ("AI-powered", "smart", "first-ever") → wins Tech Enthusiast, but sounds gimmicky to Designer
  - The winning strategy combines universal appeal (quality materials, meaningful design) with one or two distinctive hooks that no persona will dismiss

Return ONLY the pen description text. No quotation marks, no explanation, no markdown. Pure text. If you exceed 140 characters you lose everything.`,

  systemContext: `You are a master copywriter specializing in high-conversion product descriptions under strict character limits. You understand that the median rewards broad appeal, not maximum wow. You think about what each of the 5 personas would pay and aim for a description that no persona would score below $40 and no persona above $500 — the tight middle is the optimum. You count characters before submitting. You never exceed 140.`,

  // Unused for text challenges but required by the interface
  starterPath: "candidate.txt",

  solutionFileName: "candidate.txt",

  baselineScoreReference: 100,

  // Our mock evaluator lives in ~/Projects/persuasion-challenge/eval.py
  // The runner runs with cwd = challengeRepoPath (set via --challenge-repo)
  // so this command resolves relative to that directory.
  evaluatorCommand: (solutionPath, _seed) =>
    `python eval.py "${solutionPath}"`,

  parseScore: (stdout: string): number => {
    // eval.py prints: "Median price: 185.00"
    const patterns = [
      /Median\s+price:\s*(-?[\d.]+)/i,
      /median[:\s]+(-?[\d.]+)/i,
      /score[:\s]+(-?[\d.]+)/i,
    ];
    for (const p of patterns) {
      const m = stdout.match(p);
      if (m) return parseFloat(m[1]);
    }
    return Number.NEGATIVE_INFINITY;
  },

  parseFailures: (stdout: string): FailureSignal[] => {
    const failures: FailureSignal[] = [];

    // ValidationError from eval.py (e.g. over char limit, empty file)
    if (/ValidationError/i.test(stdout)) {
      const charMatch = stdout.match(/(\d+)\s+chars?,?\s*max\s+is\s+(\d+)/i);
      if (charMatch) {
        failures.push({
          category: "over-char-limit",
          message: `Description is ${charMatch[1]} chars, max is ${charMatch[2]}`,
          severity: 1.0,
          evidence: { length: parseInt(charMatch[1], 10), maxLength: parseInt(charMatch[2], 10) },
        });
      } else {
        failures.push({
          category: "validation-error",
          message: extractValidationError(stdout),
          severity: 1.0,
          evidence: { raw: stdout.slice(0, 400) },
        });
      }
      return failures;
    }

    // Median below baseline — underperforming
    const medianMatch = stdout.match(/Median\s+price:\s*(-?[\d.]+)/i);
    if (medianMatch) {
      const median = parseFloat(medianMatch[1]);
      if (median < 50) {
        failures.push({
          category: "median-too-low",
          message: `Median price ${median.toFixed(2)} — buyers are rejecting the description or lowballing heavily`,
          severity: 0.8,
          evidence: { median },
        });
      }
    }

    // Check if any persona paid 0 — asymmetry hurts median
    const zeroPersonas = [...stdout.matchAll(/\[([^\]]+)\][^\n]*\$?\s*0\.00/gi)];
    if (zeroPersonas.length >= 2) {
      failures.push({
        category: "too-polarizing",
        message: `${zeroPersonas.length} personas refused to pay anything — description is too narrow`,
        severity: 0.7,
        evidence: { rejectedPersonas: zeroPersonas.map((m) => m[1]) },
      });
    }

    return failures;
  },
};

function extractValidationError(stdout: string): string {
  const match = stdout.match(/ValidationError:\s*([^\n]+)/i);
  return match ? match[1].slice(0, 200) : "Unknown validation error";
}

// ============================================================================
// Seed Gene Capsules — 7 pre-loaded priors from general copywriting wisdom
// ============================================================================

export const persuasionSeedCapsules: SeedCapsule[] = [
  {
    id: "persuasion-seed-001",
    trigger: { category: "over-char-limit" },
    repair: {
      strategy: "Count every character including spaces and punctuation before submitting. Target 120-135 characters to leave a safety margin. If over, cut filler words first ('very', 'truly', 'really', articles like 'a' and 'the' where grammatical), then fuse adjacent adjectives ('solid German' instead of 'solid, German-made'), then drop the least impactful phrase entirely.",
      rationale: "The hard 140 limit is the most common failure mode. A description that scores 500 but is 141 chars scores 0.",
    },
    tokenCost: 120,
    source: "seed",
    confidence: 0.95,
  },
  {
    id: "persuasion-seed-002",
    trigger: { category: "median-too-low" },
    repair: {
      strategy: "The median rewards BREADTH, not PEAK. If 3 out of 5 personas are paying under $50, the median is under $50 regardless of how high the other 2 go. Rewrite to ensure EVERY persona finds at least one thing they value: material quality (Engineer + Collector), understated aesthetic (Minimalist), novel feature (Tech), and affordable-sounding baseline (Student).",
      rationale: "Optimizing for mean or max destroys the median. The correct mental model is 'minimum acceptable price across buyers', not 'maximum willingness to pay'.",
    },
    tokenCost: 180,
    source: "seed",
    confidence: 0.88,
  },
  {
    id: "persuasion-seed-003",
    trigger: { category: "too-polarizing" },
    repair: {
      strategy: "If 2+ personas refused to pay ($0), the description is signaling too narrowly. Remove absolute luxury markers ('handcrafted in Switzerland', 'gold-plated', 'heirloom') OR absolute budget markers ('cheap', 'basic', 'no-frills'). Replace with neutral-premium language ('precision-machined', 'well-weighted', 'writes reliably') that appeals across the income spectrum.",
      rationale: "A single $0 in the price list drops the median by roughly 20%. Two zeros can destroy the score entirely. Universal appeal > distinctive voice.",
    },
    tokenCost: 160,
    source: "seed",
    confidence: 0.85,
  },
  {
    id: "persuasion-seed-004",
    trigger: { category: "plateau" },
    repair: {
      strategy: "When stuck, switch dimensions: if you've been optimizing adjectives, try restructuring the sentence around a concrete verb ('writes smoothly for hours', 'slips into any pocket'). If you've been describing materials, try describing the USE CASE (morning journal, signing contracts, gift for engineer father).",
      rationale: "Late-stage plateaus usually mean you've exhausted variations within one rhetorical frame. Changing the frame (adjective → verb → use-case) breaks the ceiling.",
    },
    tokenCost: 140,
    source: "seed",
    confidence: 0.72,
  },
  {
    id: "persuasion-seed-005",
    trigger: { category: "persuasion:median-too-low", conditions: { hint: "sensory-detail" } },
    repair: {
      strategy: "Concrete sensory details beat generic superlatives. Replace 'luxurious feel' with 'cool brass weight', 'high quality' with 'smooth ink flow', 'elegant design' with 'matte black body, gold nib'. Sensory words trigger valuation in all 5 personas because they imply the writer actually saw and touched the object.",
      rationale: "LLM judges anchor on specificity as a quality signal. Abstract puffery triggers skepticism; concrete nouns trigger trust and higher bids.",
    },
    tokenCost: 170,
    source: "seed",
    confidence: 0.8,
  },
  {
    id: "persuasion-seed-006",
    trigger: { category: "persuasion:median-too-low", conditions: { hint: "single-hook" } },
    repair: {
      strategy: "Include ONE distinctive hook that no persona will dismiss: either a verifiable provenance detail ('Made in Osaka since 1962'), a universally respected material ('solid brass', 'titanium nib'), or a cross-demographic use case ('writes underwater, upside down, in zero gravity' — appeals to Tech + Collector + Engineer). One strong hook lifts all bids; multiple hooks compete for 140 chars and dilute each other.",
      rationale: "Breadth without distinctiveness = boring = low bids across the board. One sharp hook + broad vocabulary = highest median.",
    },
    tokenCost: 200,
    source: "seed",
    confidence: 0.76,
  },
  {
    id: "persuasion-seed-007",
    trigger: { category: "validation-error" },
    repair: {
      strategy: "Return ONLY the description text itself. No quotation marks around it, no markdown, no preamble ('Here is the description:'), no trailing newline explanations. The validator reads the entire file as the candidate description.",
      rationale: "LLMs often wrap output in quotes or prose explanations. The validator treats all of that as part of the description, usually pushing it over the 140 char limit or making it look bizarre to the judges.",
    },
    tokenCost: 100,
    source: "seed",
    confidence: 0.92,
  },
];

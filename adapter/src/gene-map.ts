/**
 * Gene Map — SQLite persistence of repair strategies.
 *
 * This is a minimal mirror of @helix-agent/core's Gene Map for the hackathon.
 * Tomorrow we'll swap this out for @vial-agent/runtime's actual store, but
 * for the skeleton we keep it standalone so the adapter can be developed
 * and demo'd without the monorepo wired up.
 *
 * Schema intentionally matches the capsule shape from seed data so that
 * seeded and learned capsules are indistinguishable at query time.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { SeedCapsule } from "./types.js";

export interface StoredCapsule extends SeedCapsule {
  createdAt: string;
  hitCount: number;
  lastHitAt: string | null;
  totalScoreDelta: number; // cumulative score improvement attributed to this capsule
}

export class GeneMap {
  private db: Database.Database;

  constructor(dbPath = "./gene-map.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capsules (
        id TEXT PRIMARY KEY,
        trigger_category TEXT NOT NULL,
        trigger_conditions TEXT,
        repair_strategy TEXT NOT NULL,
        repair_rationale TEXT NOT NULL,
        token_cost INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('seed', 'learned', 'llm')),
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT,
        total_score_delta REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_trigger ON capsules(trigger_category);
      CREATE INDEX IF NOT EXISTS idx_source ON capsules(source);

      CREATE TABLE IF NOT EXISTS iterations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('baseline', 'vial')),
        iteration INTEGER NOT NULL,
        score REAL NOT NULL,
        baseline_score REAL NOT NULL,
        applied_capsules TEXT NOT NULL,
        failure_categories TEXT NOT NULL,
        generation_ms INTEGER NOT NULL,
        evaluation_ms INTEGER NOT NULL,
        code TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run ON iterations(run_id, mode, iteration);
    `);
  }

  upsertCapsule(capsule: SeedCapsule): void {
    this.db
      .prepare(
        `
      INSERT INTO capsules (id, trigger_category, trigger_conditions, repair_strategy,
                            repair_rationale, token_cost, source, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repair_strategy = excluded.repair_strategy,
        confidence = excluded.confidence
    `,
      )
      .run(
        capsule.id,
        capsule.trigger.category,
        JSON.stringify(capsule.trigger.conditions ?? {}),
        capsule.repair.strategy,
        capsule.repair.rationale,
        capsule.tokenCost,
        capsule.source,
        capsule.confidence,
        new Date().toISOString(),
      );
  }

  /**
   * Look up relevant capsules for a given failure signal. Simple strategy:
   * exact category match, ordered by confidence and recent hit rate.
   * Production Gene Map would use semantic search over trigger conditions.
   */
  findCapsules(category: string, limit = 3): StoredCapsule[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, trigger_category, trigger_conditions, repair_strategy, repair_rationale,
             token_cost, source, confidence, created_at, hit_count, last_hit_at, total_score_delta
      FROM capsules
      WHERE trigger_category = ?
      ORDER BY confidence * (1 + hit_count * 0.1) DESC
      LIMIT ?
    `,
      )
      .all(category, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      trigger: { category: r.trigger_category, conditions: JSON.parse(r.trigger_conditions) },
      repair: { strategy: r.repair_strategy, rationale: r.repair_rationale },
      tokenCost: r.token_cost,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at,
      hitCount: r.hit_count,
      lastHitAt: r.last_hit_at,
      totalScoreDelta: r.total_score_delta,
    }));
  }

  /**
   * Record that a capsule was applied and track whether it led to score
   * improvement. This is the runtime's learning signal — capsules that
   * consistently improve scores rise in confidence; those that don't decay.
   */
  recordHit(capsuleId: string, scoreDelta: number): void {
    this.db
      .prepare(
        `
      UPDATE capsules
      SET hit_count = hit_count + 1,
          last_hit_at = ?,
          total_score_delta = total_score_delta + ?,
          confidence = MIN(0.95, confidence + ?)
      WHERE id = ?
    `,
      )
      .run(
        new Date().toISOString(),
        scoreDelta,
        scoreDelta > 0 ? 0.01 : -0.02,
        capsuleId,
      );
  }

  /**
   * Synthesize a new capsule from a (failure, successful repair) pair.
   * Called during the PCEC commit phase when a repair improved the score.
   */
  learnCapsule(
    failureCategory: string,
    repairStrategy: string,
    rationale: string,
    scoreDelta: number,
    tokenCost: number,
  ): string {
    const id =
      "learned-" +
      createHash("sha256")
        .update(failureCategory + repairStrategy)
        .digest("hex")
        .slice(0, 12);

    // LLM-sourced capsules are confidence-capped at 0.7 per the constitution
    const confidence = Math.min(0.7, 0.5 + scoreDelta / 100);

    this.upsertCapsule({
      id,
      trigger: { category: failureCategory },
      repair: { strategy: repairStrategy, rationale },
      tokenCost,
      source: "llm",
      confidence,
    });
    return id;
  }

  recordIteration(row: {
    runId: string;
    mode: "baseline" | "vial";
    iteration: number;
    score: number;
    baselineScore: number;
    appliedCapsules: string[];
    failureCategories: string[];
    generationMs: number;
    evaluationMs: number;
    code: string;
    timestamp: string;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO iterations (run_id, mode, iteration, score, baseline_score,
                              applied_capsules, failure_categories, generation_ms,
                              evaluation_ms, code, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        row.runId,
        row.mode,
        row.iteration,
        row.score,
        row.baselineScore,
        JSON.stringify(row.appliedCapsules),
        JSON.stringify(row.failureCategories),
        row.generationMs,
        row.evaluationMs,
        row.code,
        row.timestamp,
      );
  }

  /** Dashboard helpers */

  getAllCapsules(): StoredCapsule[] {
    const rows = this.db.prepare(`SELECT * FROM capsules ORDER BY confidence DESC`).all() as any[];
    return rows.map((r) => ({
      id: r.id,
      trigger: { category: r.trigger_category, conditions: JSON.parse(r.trigger_conditions) },
      repair: { strategy: r.repair_strategy, rationale: r.repair_rationale },
      tokenCost: r.token_cost,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at,
      hitCount: r.hit_count,
      lastHitAt: r.last_hit_at,
      totalScoreDelta: r.total_score_delta,
    }));
  }

  getRunHistory(runId: string): any[] {
    return this.db
      .prepare(
        `
      SELECT mode, iteration, score, baseline_score, applied_capsules, timestamp
      FROM iterations WHERE run_id = ? ORDER BY iteration ASC
    `,
      )
      .all(runId);
  }

  close() {
    this.db.close();
  }
}

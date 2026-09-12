/**
 * Bulk import of historical execution evidence into the graph.
 *
 * Historical records (deploy logs, test reports, QA sessions, E2E logs) become:
 *   - procedure nodes
 *   - attributed edges (condition / guidance / pitfalls)
 *   - per-transition outcomes (success/failure + duration)
 *   - full rollouts (task, ordered trajectory, score, split)
 *
 * Every imported run/rollout carries an idempotency key, so re-importing the
 * same bundle never double-counts the statistics.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProcedureStore } from "./store.js";
import {
  ensureProcedure,
  ensureEdge,
  recordOutcome,
  type ProcedureInput,
  type EdgeInput,
  type OutcomeInput,
} from "./evolution.js";
import { recordRollout, hasEvidenceKey, type RolloutInput } from "./evolution_loop.js";

export interface EvidenceBundle {
  /** Where this evidence came from (file path, log export, session id). */
  source?: string;
  procedures?: ProcedureInput[];
  edges?: EdgeInput[];
  outcomes?: OutcomeInput[];
  rollouts?: RolloutInput[];
}

export interface ImportReport {
  files: string[];
  procedures: number;
  edges: number;
  outcomes: number;
  outcomeDuplicates: number;
  rollouts: number;
  rolloutDuplicates: number;
  errors: string[];
}

/** Load one JSON bundle file or every *.json under a directory. */
export function loadBundles(path: string): { bundles: EvidenceBundle[]; files: string[] } {
  const files: string[] = [];
  const isDir = statSync(path).isDirectory();
  if (isDir) {
    for (const entry of readdirSync(path).sort()) {
      if (entry.endsWith(".json")) files.push(join(path, entry));
    }
  } else {
    files.push(path);
  }
  const bundles: EvidenceBundle[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as EvidenceBundle | EvidenceBundle[];
    const list = Array.isArray(raw) ? raw : [raw];
    for (const bundle of list) {
      bundles.push({ source: bundle.source ?? file, ...bundle });
    }
  }
  return { bundles, files };
}

function outcomeKey(source: string, o: OutcomeInput): string {
  return [source, o.from, o.to, o.outcome, o.durationSec ?? 0, o.notes ?? ""].join("|");
}

function rolloutKey(source: string, r: RolloutInput): string {
  return [source, r.task, r.split, r.score, r.steps.join(">")].join("|");
}

export function importEvidence(
  store: ProcedureStore,
  bundles: EvidenceBundle[],
  opts: { dedupe?: boolean } = {},
): ImportReport {
  const dedupe = opts.dedupe ?? true;
  const report: ImportReport = {
    files: [],
    procedures: 0,
    edges: 0,
    outcomes: 0,
    outcomeDuplicates: 0,
    rollouts: 0,
    rolloutDuplicates: 0,
    errors: [],
  };

  for (const bundle of bundles) {
    const source = bundle.source ?? "unknown";
    if (!report.files.includes(source)) report.files.push(source);

    // Each record is fault-tolerant: one bad row must not drop the rest.
    const attempt = (label: string, fn: () => void, onDone: () => void): void => {
      try {
        fn();
        onDone();
      } catch (err) {
        report.errors.push(`${source}: ${label}: ${(err as Error).message.slice(0, 120)}`);
      }
    };

    for (const p of bundle.procedures ?? []) {
      attempt(`procedure ${p.localName}`, () => ensureProcedure(store, { ...p, name: p.name ?? p.localName }), () => report.procedures++);
    }
    for (const e of bundle.edges ?? []) {
      attempt(`edge ${e.from} -> ${e.to}`, () => ensureEdge(store, e), () => report.edges++);
    }
    for (const o of bundle.outcomes ?? []) {
      const key = outcomeKey(source, o);
      if (dedupe && hasEvidenceKey(store, key)) {
        report.outcomeDuplicates++;
        continue;
      }
      attempt(`outcome ${o.from} -> ${o.to}`, () => recordOutcome(store, { ...o, evidenceKey: key }), () => report.outcomes++);
    }
    for (const r of bundle.rollouts ?? []) {
      const key = rolloutKey(source, r);
      if (dedupe && hasEvidenceKey(store, key)) {
        report.rolloutDuplicates++;
        continue;
      }
      attempt(
        `rollout ${r.task}`,
        () =>
          recordRollout(store, {
            ...r,
            notes: r.notes ? `[${source}] ${r.notes}` : `[${source}]`,
            evidenceKey: key,
          }),
        () => report.rollouts++,
      );
    }
  }
  return report;
}

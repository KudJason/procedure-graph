/**
 * Offline self-evolution loop (arXiv 2609.09153, Sec. 3.3 / Algorithm 1).
 *
 *   Step 1 Diagnostic Rollout : record (task, trajectory, score) evidence
 *   Step 2 Mutation            : refiner proposes Add / Delete / attribute edits
 *   Step 3 Validation Gating   : candidates are applied to a COPY; a candidate
 *                                is committed only if its held-out validation
 *                                score does not decrease
 *   Step 4 Rejection Memory    : rejected candidates are retained as negative
 *                                evidence for the next proposal round
 *
 * Validation score in this repo: on the held-out rollouts (split = "val"), how
 * well the graph's rank-1 guidance agrees with what actually worked — a
 * successful rollout wants the taken transition predicted, a failed rollout
 * wants the failing transition avoided.
 */
import { ProcedureStore, resolveIri } from "./store.js";
import {
  ensureEdge,
  ensureProcedure,
  patchEdgeAttr,
  retireEdge,
  edgeIri,
} from "./evolution.js";
import { loadEdges } from "./pathfinder.js";
import { nextSteps } from "./guidance.js";
import {
  PG,
  C_ROLLOUT,
  C_PROPOSAL,
  P_TASK,
  P_TRAJECTORY,
  P_SCORE,
  P_SPLIT,
  P_TIMESTAMP,
  P_ACTOR,
  P_NOTES,
  P_EDIT,
  P_EDIT_SUMMARY,
  P_PROPOSAL_STATUS,
  P_VALIDATION_BEFORE,
  P_VALIDATION_AFTER,
  P_REJECTION_REASON,
  P_EVIDENCE_KEY,
  P_CONDITION,
  P_GUIDANCE,
  P_PITFALLS,
  P_RELATION,
  P_PRECEDES,
} from "./ontology.js";

export interface RolloutInput {
  task: string;
  steps: string[];
  score: number;
  split: "train" | "val";
  actor?: string;
  notes?: string;
  /** Idempotency key: importing the same historical record twice is a no-op. */
  evidenceKey?: string;
}

export interface Rollout {
  iri: string;
  task: string;
  steps: string[];
  score: number;
  split: string;
  timestamp?: string;
  actor?: string;
  notes?: string;
  isSuccess: boolean;
}

export type EditOp =
  | {
      op: "add_edge";
      from: string;
      to: string;
      relation?: string;
      condition?: string;
      guidance?: string;
      pitfalls?: string;
      guard?: boolean;
      reason?: string;
    }
  | { op: "delete_edge"; from: string; to: string; reason?: string }
  | {
      op: "add_node";
      localName: string;
      name?: string;
      description?: string;
      command?: string;
      docRef?: string;
      env?: string;
      risk?: string;
      reason?: string;
    }
  | {
      op: "update_edge_attributes";
      from: string;
      to: string;
      condition?: string;
      guidance?: string;
      pitfalls?: string;
      guard?: boolean;
      reason?: string;
    };

export interface EditResult {
  applied: string[];
  skipped: string[];
}

export interface StructuralReport {
  valid: boolean;
  issues: string[];
  repaired: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueIri(prefix: string): string {
  return (
    PG + prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7)
  );
}

function iriOf(nameOrIri: string): string {
  return resolveIri(nameOrIri, PG);
}

/** True when a run/rollout with this idempotency key already exists. */
export function hasEvidenceKey(store: ProcedureStore, key: string): boolean {
  const rows = store.select(
    `PREFIX pg: <${PG}> SELECT ?x WHERE { ?x pg:evidenceKey ${JSON.stringify(key)} } LIMIT 1`,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Step 1: diagnostic rollout recording
// ---------------------------------------------------------------------------

export function recordRollout(store: ProcedureStore, input: RolloutInput): { rolloutIri: string } {
  const rolloutIri = uniqueIri("rollout");
  const steps = input.steps.map((s) => iriOf(s));
  store.update(
    `PREFIX pg: <${PG}>
INSERT DATA {
  <${rolloutIri}> a <${C_ROLLOUT}> ;
    <${P_TASK}> ${JSON.stringify(input.task)} ;
    <${P_TRAJECTORY}> ${JSON.stringify(steps.join(">"))} ;
    <${P_SCORE}> ${Math.max(0, Math.min(1, input.score))} ;
    <${P_SPLIT}> ${JSON.stringify(input.split)} ;
    <${P_TIMESTAMP}> ${JSON.stringify(nowIso())} ;
    <${P_ACTOR}> ${JSON.stringify(input.actor ?? "unknown")} .
  ${input.notes ? `<${rolloutIri}> <${P_NOTES}> ${JSON.stringify(input.notes)} .` : ""}
  ${input.evidenceKey ? `<${rolloutIri}> <${P_EVIDENCE_KEY}> ${JSON.stringify(input.evidenceKey)} .` : ""}
}`,
  );
  return { rolloutIri };
}

export function listRollouts(
  store: ProcedureStore,
  opts: { split?: "train" | "val"; limit?: number } = {},
): Rollout[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?r ?task ?traj ?score ?split ?ts ?actor ?notes WHERE {
      ?r a pg:Rollout ; pg:task ?task ; pg:trajectory ?traj ; pg:score ?score .
      OPTIONAL { ?r pg:split ?split }
      OPTIONAL { ?r pg:timestamp ?ts }
      OPTIONAL { ?r pg:actor ?actor }
      OPTIONAL { ?r pg:notes ?notes }
    } ORDER BY DESC(?ts) LIMIT ${limit}
  `);
  return rows
    .filter((r) => !opts.split || (r.split?.value ?? "train") === opts.split)
    .map((r) => {
      const score = Number(r.score!.value);
      return {
        iri: r.r!.value,
        task: r.task!.value,
        steps: r.traj!.value.split(">").filter(Boolean),
        score,
        split: r.split?.value ?? "train",
        timestamp: r.ts?.value,
        actor: r.actor?.value,
        notes: r.notes?.value,
        isSuccess: score >= 0.5,
      };
    });
}

// ---------------------------------------------------------------------------
// Validation score (Eq. 4)
// ---------------------------------------------------------------------------

/**
 * S_val(G): agreement between the graph's rank-1 guidance and held-out outcomes.
 * Returns null when there is no validation evidence yet.
 */
export function evaluateGraph(
  store: ProcedureStore,
  rollouts?: Rollout[],
): { score: number | null; evaluated: number; details: Array<{ task: string; score: number; hits: number; steps: number }> } {
  const val = (rollouts ?? listRollouts(store, { split: "val", limit: 500 })).filter(
    (r) => r.split === "val",
  );
  if (val.length === 0) return { score: null, evaluated: 0, details: [] };

  const details: Array<{ task: string; score: number; hits: number; steps: number }> = [];
  let hits = 0;
  let total = 0;

  for (const r of val) {
    let rolloutHits = 0;
    let rolloutSteps = 0;
    for (let i = 0; i < r.steps.length - 1; i++) {
      const from = r.steps[i];
      const actualNext = r.steps[i + 1];
      const predicted = nextSteps(store, from)[0]?.iri;
      if (!predicted) continue;
      rolloutSteps++;
      const agrees = predicted === actualNext;
      // Successful rollouts reward predicting the taken step; failed rollouts
      // reward steering away from the step that led to failure.
      if (r.isSuccess ? agrees : !agrees) rolloutHits++;
    }
    total += rolloutSteps;
    hits += rolloutHits;
    details.push({
      task: r.task,
      score: rolloutSteps > 0 ? rolloutHits / rolloutSteps : 0,
      hits: rolloutHits,
      steps: rolloutSteps,
    });
  }
  return { score: total > 0 ? hits / total : null, evaluated: val.length, details };
}

// ---------------------------------------------------------------------------
// Step 2/3: candidate application + structural checks on a copy
// ---------------------------------------------------------------------------

/** Apply an edit set to a store. Used both on candidate copies and on commit. */
export function applyEdits(store: ProcedureStore, edits: EditOp[]): EditResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const edit of edits) {
    try {
      switch (edit.op) {
        case "add_edge": {
          ensureEdge(store, {
            from: edit.from,
            to: edit.to,
            relation: edit.relation,
            condition: edit.condition,
            guidance: edit.guidance,
            pitfalls: edit.pitfalls,
            guard: edit.guard,
          });
          applied.push(`add_edge ${edit.from} -> ${edit.to}`);
          break;
        }
        case "delete_edge": {
          retireEdge(store, edgeIri(iriOf(edit.from), iriOf(edit.to)));
          applied.push(`delete_edge ${edit.from} -> ${edit.to}`);
          break;
        }
        case "add_node": {
          ensureProcedure(store, { ...edit, name: edit.name ?? edit.localName });
          applied.push(`add_node ${edit.localName}`);
          break;
        }
        case "update_edge_attributes": {
          const e = edgeIri(iriOf(edit.from), iriOf(edit.to));
          if (edit.condition) patchEdgeAttr(store, e, P_CONDITION, edit.condition);
          if (edit.guidance) patchEdgeAttr(store, e, P_GUIDANCE, edit.guidance);
          if (edit.pitfalls) patchEdgeAttr(store, e, P_PITFALLS, edit.pitfalls);
          applied.push(`update_edge_attributes ${edit.from} -> ${edit.to}`);
          break;
        }
      }
    } catch (err) {
      skipped.push(`${edit.op}: ${(err as Error).message}`);
    }
  }
  return { applied, skipped };
}

/**
 * Structural checks on a copy of the graph:
 *  - self-loops are removed
 *  - precedes-cycles are repaired by removing the least-observed back edge
 *  - edges referencing unknown nodes are reported
 */
export function structuralCheck(
  store: ProcedureStore,
  edits: EditOp[] = [],
): { report: StructuralReport; candidate: ProcedureStore } {
  const candidate = new ProcedureStore(
    "/tmp/pg-candidate-" + Math.random().toString(36).slice(2) + ".nq",
    "/tmp/pg-nonexistent-seed.ttl",
  );
  store.clone(candidate);
  applyEdits(candidate, edits);

  const issues: string[] = [];
  const repaired: string[] = [];

  // Remove self-loops.
  for (const e of loadEdges(candidate)) {
    if (e.from === e.to) {
      retireEdge(candidate, e.edgeIri);
      repaired.push(`removed self-loop ${e.edgeIri.split("#").pop()}`);
    }
  }

  // Cycle repair: repeatedly break precedes-cycles at their weakest edge.
  for (let round = 0; round < 25; round++) {
    const cycle = findCycle(candidate);
    if (!cycle) break;
    const observations = new Map(
      loadEdges(candidate).map((e) => [e.edgeIri, e.successCount + e.failCount]),
    );
    const weakest = cycle.reduce((acc, cur) =>
      (observations.get(cur) ?? 0) <= (observations.get(acc) ?? 0) ? cur : acc,
    );
    retireEdge(candidate, weakest);
    repaired.push(`cycle repaired by removing ${weakest.split("#").pop()}`);
  }

  // Dangling edges: endpooints that are not declared procedures.
  const known = new Set(
    candidate
      .select(`PREFIX pg: <${PG}> SELECT ?p WHERE { ?p a pg:Procedure }`)
      .map((r) => r.p!.value),
  );
  for (const e of loadEdges(candidate)) {
    if (!known.has(e.from) || !known.has(e.to)) {
      issues.push(`dangling edge ${e.edgeIri.split("#").pop()}`);
    }
  }

  return { report: { valid: issues.length === 0, issues, repaired }, candidate };
}

/** Depth-first search for one cycle among active precedes edges. */
function findCycle(store: ProcedureStore): string[] | null {
  const adjacency = new Map<string, Array<{ to: string; edgeIri: string }>>();
  for (const e of loadEdges(store)) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push({ to: e.to, edgeIri: e.edgeIri });
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: Array<{ to: string; edgeIri: string }> = [];

  const visit = (node: string): string[] | null => {
    state.set(node, "visiting");
    for (const next of adjacency.get(node) ?? []) {
      const st = state.get(next.to);
      if (st === "visiting") {
        const idx = stack.findIndex((s) => s.to === next.to);
        const cycle = stack.slice(idx >= 0 ? idx : 0).map((s) => s.edgeIri);
        return [...cycle, next.edgeIri];
      }
      if (!st) {
        stack.push(next);
        const found = visit(next.to);
        if (found) return found;
        stack.pop();
      }
    }
    state.set(node, "done");
    return null;
  };

  for (const node of adjacency.keys()) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Steps 2-4: proposal, gating, rejection memory
// ---------------------------------------------------------------------------

export interface ProposalRecord {
  iri: string;
  summary: string;
  edits: EditOp[];
  status: string;
  validationBefore: number | null;
  validationAfter: number | null;
  rejectionReason?: string;
  timestamp?: string;
  actor?: string;
}

export function proposeEdits(
  store: ProcedureStore,
  input: { summary: string; edits: EditOp[]; actor?: string },
): {
  proposalIri: string;
  validationBefore: number | null;
  structural: StructuralReport;
} {
  const structural = structuralCheck(store, input.edits).report;
  const current = evaluateGraph(store);
  const proposalIri = uniqueIri("proposal");
  store.update(
    `PREFIX pg: <${PG}>
INSERT DATA {
  <${proposalIri}> a <${C_PROPOSAL}> ;
    <${P_EDIT_SUMMARY}> ${JSON.stringify(input.summary)} ;
    <${P_EDIT}> ${JSON.stringify(JSON.stringify(input.edits))} ;
    <${P_PROPOSAL_STATUS}> "pending" ;
    <${P_TIMESTAMP}> ${JSON.stringify(nowIso())} ;
    <${P_ACTOR}> ${JSON.stringify(input.actor ?? "unknown")} .
  ${current.score !== null ? `<${proposalIri}> <${P_VALIDATION_BEFORE}> ${current.score} .` : ""}
}`,
  );
  return { proposalIri, validationBefore: current.score, structural };
}

export function getProposal(store: ProcedureStore, proposalIri: string): ProposalRecord | null {
  const full = iriOf(proposalIri);
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?summary ?edit ?status ?before ?after ?reason ?ts ?actor WHERE {
      <${full}> a pg:Proposal ; pg:editSummary ?summary ; pg:edit ?edit .
      OPTIONAL { <${full}> pg:proposalStatus ?status }
      OPTIONAL { <${full}> pg:validationBefore ?before }
      OPTIONAL { <${full}> pg:validationAfter ?after }
      OPTIONAL { <${full}> pg:rejectionReason ?reason }
      OPTIONAL { <${full}> pg:timestamp ?ts }
      OPTIONAL { <${full}> pg:actor ?actor }
    } LIMIT 1
  `);
  if (rows.length === 0) return null;
  const r = rows[0];
  let edits: EditOp[] = [];
  try {
    edits = JSON.parse(r.edit!.value) as EditOp[];
  } catch {
    edits = [];
  }
  return {
    iri: full,
    summary: r.summary!.value,
    edits,
    status: r.status?.value ?? "pending",
    validationBefore: r.before ? Number(r.before.value) : null,
    validationAfter: r.after ? Number(r.after.value) : null,
    rejectionReason: r.reason?.value,
    timestamp: r.ts?.value,
    actor: r.actor?.value,
  };
}

/**
 * Validation gate (Eq. 5): commit the candidate only when its held-out score
 * does not decrease; otherwise reject it into the rejection memory.
 */
export function validateProposal(
  store: ProcedureStore,
  input: { proposalIri: string; apply?: boolean },
): {
  status: "committed" | "rejected" | "pending";
  validationBefore: number | null;
  validationAfter: number | null;
  reason?: string;
  structural: StructuralReport;
} {
  const proposal = getProposal(store, input.proposalIri);
  if (!proposal) {
    return {
      status: "pending",
      validationBefore: null,
      validationAfter: null,
      reason: "proposal not found",
      structural: { valid: false, issues: ["proposal not found"], repaired: [] },
    };
  }
  if (proposal.status !== "pending") {
    return {
      status: proposal.status as "committed" | "rejected",
      validationBefore: proposal.validationBefore,
      validationAfter: proposal.validationAfter,
      reason: proposal.rejectionReason,
      structural: { valid: true, issues: [], repaired: [] },
    };
  }

  const { report, candidate } = structuralCheck(store, proposal.edits);
  const before = proposal.validationBefore ?? evaluateGraph(store).score;
  const after = evaluateGraph(candidate).score;

  const setStatus = (
    status: string,
    reason?: string,
  ): void => {
    store.update(
      `PREFIX pg: <${PG}>
DELETE { <${proposal.iri}> <${P_PROPOSAL_STATUS}> ?old }
INSERT {
  <${proposal.iri}> <${P_PROPOSAL_STATUS}> ${JSON.stringify(status)} ;
    <${P_TIMESTAMP}> ${JSON.stringify(nowIso())} .
  ${after !== null ? `<${proposal.iri}> <${P_VALIDATION_AFTER}> ${after} .` : ""}
  ${reason ? `<${proposal.iri}> <${P_REJECTION_REASON}> ${JSON.stringify(reason)} .` : ""}
}
WHERE { OPTIONAL { <${proposal.iri}> <${P_PROPOSAL_STATUS}> ?old } }`,
    );
  };

  if (!report.valid) {
    setStatus("rejected", `structural check failed: ${report.issues.join("; ")}`);
    return {
      status: "rejected",
      validationBefore: before,
      validationAfter: after,
      reason: "structural check failed",
      structural: report,
    };
  }

  if (after === null) {
    // Not enough held-out evidence: keep the proposal pending rather than guess.
    return {
      status: "pending",
      validationBefore: before,
      validationAfter: null,
      reason:
        "no validation rollouts on split=val; record held-out evidence before gating",
      structural: report,
    };
  }

  const gatePassed = before === null || after >= before;
  if (!gatePassed) {
    setStatus("rejected", `validation score decreased: ${before} -> ${after}`);
    return {
      status: "rejected",
      validationBefore: before,
      validationAfter: after,
      reason: `validation score decreased: ${before} -> ${after}`,
      structural: report,
    };
  }

  applyEdits(store, proposal.edits);
  // Re-apply repairs (cycle breaking) so the committed graph matches the candidate.
  for (const repair of report.repaired) {
    const edgeLocal = repair.split(" ").pop();
    if (repair.startsWith("cycle repaired") || repair.startsWith("removed self-loop")) {
      const match = loadEdges(store).find((e) => e.edgeIri.split("#").pop() === edgeLocal);
      if (match) retireEdge(store, match.edgeIri);
    }
  }
  setStatus("committed");
  return {
    status: "committed",
    validationBefore: before,
    validationAfter: after,
    structural: report,
  };
}

/** Step 4: rejected candidates become negative evidence for the refiner. */
export function rejectionMemory(store: ProcedureStore, limit = 10): ProposalRecord[] {
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?p WHERE {
      ?p a pg:Proposal ; pg:proposalStatus "rejected" .
    } ORDER BY DESC(?ts) LIMIT ${Math.max(1, Math.min(100, limit))}
  `);
  return rows
    .map((r) => getProposal(store, r.p!.value))
    .filter((p): p is ProposalRecord => p !== null);
}

export function listProposals(
  store: ProcedureStore,
  status?: string,
): Array<{ iri: string; summary: string; status: string; before: number | null; after: number | null }> {
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?p ?summary ?status ?before ?after WHERE {
      ?p a pg:Proposal ; pg:editSummary ?summary .
      OPTIONAL { ?p pg:proposalStatus ?status }
      OPTIONAL { ?p pg:validationBefore ?before }
      OPTIONAL { ?p pg:validationAfter ?after }
    }
  `);
  return rows
    .filter((r) => !status || (r.status?.value ?? "pending") === status)
    .map((r) => ({
      iri: r.p!.value,
      summary: r.summary!.value,
      status: r.status?.value ?? "pending",
      before: r.before ? Number(r.before.value) : null,
      after: r.after ? Number(r.after.value) : null,
    }));
}

/**
 * Refiner input bundle: contrast successful vs failed traces, expose failing
 * edges and the rejection memory — everything the refiner needs to propose
 * the next edit set (Step 2 and Step 4 of the loop).
 */
export function refineContext(
  store: ProcedureStore,
  opts: { trainLimit?: number } = {},
): {
  validationScore: number | null;
  failingEdges: Array<{ edge: string; attempts: number; successRatio: number; pitfalls?: string }>;
  successfulTraces: Array<{ task: string; trajectory: string }>;
  failedTraces: Array<{ task: string; trajectory: string }>;
  rejectedProposals: Array<{ summary: string; edits: EditOp[]; reason?: string }>;
  instruction: string;
} {
  const train = listRollouts(store, { split: "train", limit: opts.trainLimit ?? 50 });
  const edges = loadEdges(store)
    .filter((e) => e.failCount > 0)
    .sort((a, b) => a.successRatio - b.successRatio)
    .slice(0, 10);
  return {
    validationScore: evaluateGraph(store).score,
    failingEdges: edges.map((e) => ({
      edge: e.edgeIri,
      attempts: e.successCount + e.failCount,
      successRatio: e.successRatio,
      pitfalls: e.pitfalls,
    })),
    successfulTraces: train
      .filter((r) => r.isSuccess)
      .map((r) => ({ task: r.task, trajectory: r.steps.map((s) => s.split("#").pop()).join(" -> ") })),
    failedTraces: train
      .filter((r) => !r.isSuccess)
      .map((r) => ({ task: r.task, trajectory: r.steps.map((s) => s.split("#").pop()).join(" -> ") })),
    rejectedProposals: rejectionMemory(store, 10).map((p) => ({
      summary: p.summary,
      edits: p.edits,
      reason: p.rejectionReason,
    })),
    instruction:
      "Contrast failed vs successful traces, then propose Add missing verification nodes/edges, Delete failure-inducing edges, or revise edge attributes (condition/guidance/pitfalls). Do not repeat edits listed in rejectedProposals.",
  };
}

export { P_RELATION };

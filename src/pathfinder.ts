/**
 * Success-weighted pathfinding: finds the fastest path that is most likely
 * to succeed ("fastest successful path") using Laplace-smoothed success
 * ratios and observed durations from the graph's self-evolution stats.
 */
import { ProcedureStore } from "./store.js";
import { PG } from "./ontology.js";
import { C_EDGE, P_FROM, P_TO, P_RELATION, P_CONDITION, P_PRECEDES, P_REQUIRES, P_SUCCESS_COUNT, P_FAIL_COUNT, P_AVG_DURATION_SEC, P_STATUS, P_GUARD, STATUS_ACTIVE, STATUS_RETIRED, P_NAME, P_COMMAND, P_DOC_REF, P_RISK } from "./ontology.js";

export interface EdgeStats {
  edgeIri: string;
  from: string;
  to: string;
  relation: string;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
  guard: boolean;
  successCount: number;
  failCount: number;
  avgDurationSec: number;
  /** Laplace-smoothed success probability */
  successRatio: number;
  /** Cost model: expected time penalized by failure probability */
  cost: number;
}

export interface PathStep {
  from: string;
  to: string;
  edgeIri: string;
  condition?: string;
  expectedDurationSec: number;
  successRatio: number;
  /** precedes for execution order, requires for an expanded prerequisite. */
  relation?: string;
  /** True when this step was pulled in as a prerequisite of a later step. */
  isPrerequisite?: boolean;
}

const NO_DATA_PRIOR_DURATION = 60;

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number((v as { value: string }).value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Load edges. By default every relation is returned so guidance can show
 * prerequisites (requires) and alternatives; pathfinding passes
 * { relations: [P_PRECEDES] } because only precedes edges form execution order.
 */
export function loadEdges(
  store: ProcedureStore,
  opts: { relations?: string[]; includeGuards?: boolean } = {},
): EdgeStats[] {
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?e ?from ?to ?rel ?cond ?guide ?pit ?guard ?sc ?fc ?dur ?st WHERE {
      ?e a pg:Edge ;
         pg:from ?from ;
         pg:to ?to ;
         pg:relation ?rel .
      OPTIONAL { ?e pg:condition ?cond }
      OPTIONAL { ?e pg:guidance ?guide }
      OPTIONAL { ?e pg:pitfalls ?pit }
       OPTIONAL { ?e pg:guard ?guard }
      OPTIONAL { ?e pg:successCount ?sc }
      OPTIONAL { ?e pg:failCount ?fc }
      OPTIONAL { ?e pg:avgDurationSec ?dur }
      OPTIONAL { ?e pg:status ?st }
    }
  `);
  return rows
    .filter((r) => (r.st?.value ?? STATUS_ACTIVE) !== STATUS_RETIRED)
    .filter((r) => opts.includeGuards !== false || r.guard?.value !== "true")
    .filter((r) => !opts.relations || opts.relations.includes(r.rel!.value))
    .map((r) => {
      const sc = num(r.sc);
      const fc = num(r.fc);
      const dur = num(r.dur);
      const successRatio = (sc + 1) / (sc + fc + 2); // Laplace smoothing
      const expected = dur > 0 ? dur : NO_DATA_PRIOR_DURATION;
      // Failure costs a full retry of this step plus lost time.
      const cost = expected + (1 - successRatio) * expected * 2;
      return {
        edgeIri: r.e!.value,
        from: r.from!.value,
        to: r.to!.value,
        relation: r.rel!.value,
        condition: r.cond?.value,
        guidance: r.guide?.value,
        pitfalls: r.pit?.value,
        guard: r.guard?.value === "true",
        successCount: sc,
        failCount: fc,
        avgDurationSec: dur,
        successRatio,
        cost,
      };
    });
}

/** Dijkstra over precedes-edges from start to goal. */
export interface Prerequisite {
  /** The step that needs something done first. */
  forNode: string;
  /** The step that must be completed first (target of the requires edge). */
  required: string;
  depth: number;
}

/**
 * Transitive prerequisites of the given nodes.
 *
 * Convention: (A pg:requires B) means "A requires B", so B must be completed
 * before A. Pathfinding only follows precedes edges, so prerequisites are
 * reported separately — otherwise the "fastest path" silently omits the steps
 * that are known to block it (e.g. vendoring the Detox pod before pod install).
 */
export function prerequisitesFor(
  store: ProcedureStore,
  nodes: string[],
  maxDepth = 2,
): Prerequisite[] {
  const requiresEdges = loadEdges(store).filter((e) => e.relation === P_REQUIRES);
  const adjacency = new Map<string, string[]>();
  for (const e of requiresEdges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }

  const inPath = new Set(nodes);
  const found = new Map<string, Prerequisite>();
  const queue: Array<{ node: string; depth: number }> = nodes.map((n) => ({ node: n, depth: 0 }));
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const target of adjacency.get(node) ?? []) {
      if (inPath.has(target)) continue;
      const key = `${node}->${target}`;
      if (found.has(key)) continue;
      found.set(key, { forNode: node, required: target, depth: depth + 1 });
      queue.push({ node: target, depth: depth + 1 });
    }
  }
  return [...found.values()].sort((a, b) => a.depth - b.depth);
}

export function findFastestPath(
  store: ProcedureStore,
  startIri: string,
  goalIri: string,
): PathStep[] | null {
  const edges = loadEdges(store, { relations: [P_PRECEDES], includeGuards: false });
  const adj = new Map<string, EdgeStats[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e);
  }

  const dist = new Map<string, number>([[startIri, 0]]);
  const prev = new Map<string, EdgeStats>();
  const visited = new Set<string>();
  // Simple O(V^2) Dijkstra is fine at this graph size.
  while (true) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < best) {
        cur = node;
        best = d;
      }
    }
    if (cur === null) break;
    if (cur === goalIri) break;
    visited.add(cur);
    for (const e of adj.get(cur) ?? []) {
      const nd = best + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, e);
      }
    }
  }
  if (!dist.has(goalIri) || (startIri !== goalIri && !prev.has(goalIri))) {
    return null;
  }
  const path: PathStep[] = [];
  let node = goalIri;
  while (node !== startIri) {
    const e = prev.get(node);
    if (!e) return null;
    path.unshift({
      from: e.from,
      to: e.to,
      edgeIri: e.edgeIri,
      condition: e.condition,
      expectedDurationSec: e.avgDurationSec > 0 ? e.avgDurationSec : NO_DATA_PRIOR_DURATION,
      successRatio: e.successRatio,
      relation: P_PRECEDES,
    });
    node = e.from;
  }
  return expandWithPrerequisites(store, path);
}

/**
 * Insert transitive prerequisites before the steps that need them.
 *
 * A precedes-only path is not executable on its own: the Detox suite path, for
 * example, silently skipped "vendor the Detox pod" and "pod install" because
 * those are requires-edges rather than precedes-edges, and every recorded run
 * that skipped them failed.
 */
export function expandWithPrerequisites(
  store: ProcedureStore,
  path: PathStep[],
  maxDepth = 3,
): PathStep[] {
  const emitted = new Set<string>();
  const out: PathStep[] = [];
  for (const step of path) {
    const pres = prerequisitesFor(store, [step.to], maxDepth)
      // Deepest first: a prerequisite of a prerequisite must run earliest.
      .sort((a, b) => b.depth - a.depth);
    for (const pre of pres) {
      if (emitted.has(pre.required)) continue;
      emitted.add(pre.required);
      out.push({
        from: pre.forNode,
        to: pre.required,
        edgeIri: edgeIriForPair(pre.forNode, pre.required),
        expectedDurationSec: NO_DATA_PRIOR_DURATION,
        successRatio: 0.5,
        relation: P_REQUIRES,
        isPrerequisite: true,
      });
    }
    if (!emitted.has(step.to)) {
      emitted.add(step.to);
      out.push(step);
    }
  }
  return out;
}

function edgeIriForPair(fromIri: string, toIri: string): string {
  const local = (iri: string): string => iri.split("#").pop() ?? iri;
  return (PG + "edge-" + local(fromIri) + "-" + local(toIri)).toLowerCase();
}

export function nodeLabel(store: ProcedureStore, iri: string): string {
  const rows = store.select(`
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?l WHERE { <${iri}> rdfs:label ?l } LIMIT 1
  `);
  return rows[0]?.l?.value ?? iri;
}

export function nodeDetails(store: ProcedureStore, iri: string): Record<string, unknown> {
  const rows = store.select(`
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX pg: <${PG}>
    SELECT ?cmd ?doc ?risk ?env WHERE {
      OPTIONAL { <${iri}> pg:command ?cmd }
      OPTIONAL { <${iri}> pg:docRef ?doc }
      OPTIONAL { <${iri}> pg:risk ?risk }
      OPTIONAL { <${iri}> pg:env ?env }
    } LIMIT 1
  `);
  const r = rows[0] ?? {};
  return {
    iri,
    name: nodeLabel(store, iri),
    command: r.cmd?.value,
    docRef: r.doc?.value,
    risk: r.risk?.value,
    env: r.env?.value,
  };
}

export { C_EDGE, P_FROM, P_TO, P_RELATION, P_CONDITION, P_SUCCESS_COUNT, P_FAIL_COUNT, P_AVG_DURATION_SEC, P_STATUS, P_NAME, P_COMMAND, P_DOC_REF, P_RISK };

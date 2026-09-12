/**
 * Online inference side of the Procedural Graph (arXiv 2609.09153, Sec. 3.2).
 *
 *   u_t = Match(a_{t-1}, V)             locate the active node
 *   G_t = N_h(u_t)                      h-hop outgoing neighborhood (h = 2)
 *   g_t = Psi(G_t, q, T_{t-w:t})        guidance from subgraph + last w steps
 *
 * Here the guidance model Psi is the calling agent itself, so instead of
 * invoking an LLM we serialize the neighborhood — with the paper's edge
 * attributes (condition / guidance / pitfalls) — into prompt-ready text.
 */
import { ProcedureStore, resolveIri } from "./store.js";
import {
  loadEdges,
  nodeDetails,
  nodeLabel,
  findFastestPath,
  prerequisitesFor,
  type PathStep,
  type Prerequisite,
} from "./pathfinder.js";
import { PG, START_IRI, P_PRECEDES } from "./ontology.js";

export const DEFAULT_HOPS = 2;

export interface NextStep {
  iri: string;
  name: string;
  command?: string;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
  docRef?: string;
  expectedDurationSec: number;
  successRatio: number;
  attempts: number;
  confidence: "high" | "low";
  /** precedes = execution order; requires = prerequisite of this node. */
  relation: string;
}

export interface NeighborhoodNode {
  iri: string;
  name: string;
  kind?: string;
  depth: number;
}

export interface NeighborhoodEdge {
  from: string;
  to: string;
  relation: string;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
  depth: number;
}

export interface Neighborhood {
  root: string | null;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  truncated: boolean;
}

const MAX_NEIGHBORHOOD_EDGES = 60;

/**
 * Locate the agent's active procedure from its most recent action string.
 * Exact local-name match first (paper), then label/command containment, and
 * null when nothing matches (caller then falls back to the full graph).
 */
export function localize(
  store: ProcedureStore,
  lastAction: string,
): { iri: string; matchedBy: "name" | "label" | "command" } | null {
  const needle = lastAction.trim().toLowerCase();
  if (!needle) return null;
  const rows = store.select(`
    PREFIX pg: <${PG}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?p ?label ?command WHERE {
      ?p a pg:Procedure .
      OPTIONAL { ?p rdfs:label ?label }
      OPTIONAL { ?p pg:command ?command }
    }
  `);
  const normalizedNeedle = needle.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const r of rows) {
    const local = r.p!.value.split("#").pop()!.toLowerCase();
    if (local === needle || local === normalizedNeedle) {
      return { iri: r.p!.value, matchedBy: "name" };
    }
  }
  for (const r of rows) {
    const label = r.label?.value?.toLowerCase() ?? "";
    if (label && (label === needle || label.includes(needle))) {
      return { iri: r.p!.value, matchedBy: "label" };
    }
  }
  for (const r of rows) {
    const command = r.command?.value?.toLowerCase() ?? "";
    if (command && command.includes(needle)) {
      return { iri: r.p!.value, matchedBy: "command" };
    }
  }
  return null;
}

/** Breadth-first expansion over outgoing precedes/requires edges, up to h hops. */
export function neighborhood(
  store: ProcedureStore,
  rootIri: string | null,
  h: number = DEFAULT_HOPS,
): Neighborhood {
  const edges = loadEdges(store).filter((e) => e.to !== rootIri);
  const adjacency = new Map<string, typeof edges>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e);
  }

  const nodes: NeighborhoodNode[] = [];
  const seenNodes = new Set<string>();
  const outEdges: NeighborhoodEdge[] = [];
  const seenEdges = new Set<string>();
  let truncated = false;

  const roots = rootIri ? [rootIri] : [START_IRI];
  const frontier: Array<{ iri: string; depth: number }> = roots.map((iri) => ({ iri, depth: 0 }));
  for (const r of roots) {
    seenNodes.add(r);
    nodes.push({ iri: r, name: String(nodeLabel(store, r)), depth: 0 });
  }

  while (frontier.length > 0) {
    const { iri, depth } = frontier.shift()!;
    if (depth >= h) continue;
    for (const e of adjacency.get(iri) ?? []) {
      if (seenEdges.has(e.edgeIri)) continue;
      if (outEdges.length >= MAX_NEIGHBORHOOD_EDGES) {
        truncated = true;
        break;
      }
      seenEdges.add(e.edgeIri);
      outEdges.push({
        from: e.from,
        to: e.to,
        relation: e.relation,
        condition: e.condition,
        guidance: e.guidance,
        pitfalls: e.pitfalls,
        depth: depth + 1,
      });
      if (!seenNodes.has(e.to)) {
        seenNodes.add(e.to);
        nodes.push({
          iri: e.to,
          name: String(nodeLabel(store, e.to)),
          depth: depth + 1,
        });
        frontier.push({ iri: e.to, depth: depth + 1 });
      }
    }
  }
  return { root: rootIri, nodes, edges: outEdges, truncated };
}

/** Render the subgraph as situational guidance text (the guidance model's input). */
export function serializeGuidance(
  store: ProcedureStore,
  nb: Neighborhood,
  opts: { query?: string; trajectory?: string[]; goal?: string } = {},
): string {
  const lines: string[] = [];
  const rootName = nb.root ? nodeLabel(store, nb.root) : "full graph (no localization match)";
  lines.push(`[Localized] ${rootName}`);
  if (opts.query) lines.push(`[Task] ${opts.query}`);
  if (opts.trajectory?.length) {
    lines.push(`[Recent steps] ${opts.trajectory.slice(-3).join(" -> ")}`);
  }

  const bySource = new Map<string, NeighborhoodEdge[]>();
  for (const e of nb.edges) {
    if (!bySource.has(e.from)) bySource.set(e.from, []);
    bySource.get(e.from)!.push(e);
  }
  const walk = (iri: string, depth: number, seen: Set<string>): void => {
    for (const e of bySource.get(iri) ?? []) {
      if (seen.has(e.to)) continue;
      const pad = "  ".repeat(depth);
      const details = nodeDetails(store, e.to);
      const relLabel = e.relation.endsWith("precedes") ? "" : `[${e.relation.split("#").pop()}] `;
      lines.push(`${pad}-> ${relLabel}${nodeLabel(store, e.to)} (${e.to.split("#").pop()})`);
      if (details.command) lines.push(`${pad}   command: ${details.command}`);
      if (e.condition) lines.push(`${pad}   condition: ${e.condition}`);
      if (e.guidance) lines.push(`${pad}   guidance: ${e.guidance}`);
      if (e.pitfalls) lines.push(`${pad}   pitfalls: ${e.pitfalls}`);
      if (depth + 1 < DEFAULT_HOPS) walk(e.to, depth + 1, new Set([...seen, e.to]));
    }
  };
  if (nb.root) walk(nb.root, 1, new Set([nb.root]));
  if (nb.truncated) lines.push("(neighborhood truncated)");
  return lines.join("\n");
}

function envMatches(store: ProcedureStore, iri: string, env?: string): boolean {
  if (!env) return true;
  const rows = store.select(
    `PREFIX pg: <${PG}> SELECT ?env WHERE { <${iri}> pg:env ?env } LIMIT 1`,
  );
  const nodeEnv = rows[0]?.env?.value;
  return !nodeEnv || nodeEnv === "any" || nodeEnv === env;
}

/** Rank outgoing edges from the active node: best success/duration first. */
export function nextSteps(store: ProcedureStore, currentIri: string, env?: string): NextStep[] {
  const all = loadEdges(store).filter((e) => e.from === currentIri);
  // Prefer execution-order edges; fall back to other relations (e.g. requires)
  // when a node only has prerequisites, so guidance is never empty.
  const precedes = all.filter((e) => e.relation === P_PRECEDES);
  const pool = precedes.length > 0 ? precedes : all;
  const steps: NextStep[] = [];
  for (const e of pool) {
    if (!envMatches(store, e.to, env)) continue;
    const details = nodeDetails(store, e.to);
    const attempts = e.successCount + e.failCount;
    steps.push({
      iri: e.to,
      name: String(details.name),
      command: details.command as string | undefined,
      docRef: details.docRef as string | undefined,
      condition: e.condition,
      guidance: e.guidance,
      pitfalls: e.pitfalls,
      relation: e.relation,
      expectedDurationSec: e.avgDurationSec > 0 ? e.avgDurationSec : 60,
      successRatio: e.successRatio,
      attempts,
      confidence: attempts >= 3 ? "high" : "low",
    });
  }
  return steps.sort((a, b) => {
    const costA = a.expectedDurationSec + (1 - a.successRatio) * a.expectedDurationSec * 2;
    const costB = b.expectedDurationSec + (1 - b.successRatio) * b.expectedDurationSec * 2;
    return costA - costB;
  });
}

export interface Guidance {
  localized: { iri: string; matchedBy: string } | null;
  current: Record<string, unknown> | null;
  guidanceText: string;
  neighborhood: Neighborhood;
  nextSteps: NextStep[];
  prerequisites: Prerequisite[];
  fastestPath: {
    from: string;
    to: string;
    steps: PathStep[];
    /** Steps that must be completed before the path can run at all. */
    prerequisites: Prerequisite[];
    totalExpectedSec: number;
    pathSuccessProbability: number;
  } | null;
  entryPoints: Array<{
    iri: string;
    name: string;
    totalExpectedSec: number;
    pathSuccessProbability: number;
  }>;
  warnings: string[];
}

/** Outgoing transitions from the Start marker are the workflow entry points. */
export function entryPoints(store: ProcedureStore): string[] {
  const fromStart = nextSteps(store, START_IRI).map((s) => s.iri);
  if (fromStart.length > 0) return fromStart;
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?p WHERE {
      ?p a pg:Procedure .
      FILTER NOT EXISTS { ?e a pg:Edge ; pg:to ?p ; pg:relation pg:precedes }
    }
  `);
  return rows.map((r) => r.p!.value);
}

/**
 * Prerequisites that were expanded into the path plus any remaining transitive
 * ones, deduplicated. Without this the field reads empty even though the path
 * clearly contains prerequisite steps.
 */
function mergePrerequisites(path: PathStep[], transitive: Prerequisite[]): Prerequisite[] {
  const merged = new Map<string, Prerequisite>();
  for (const step of path) {
    if (step.isPrerequisite) {
      merged.set(`${step.from}->${step.to}`, { forNode: step.from, required: step.to, depth: 1 });
    }
  }
  for (const pre of transitive) {
    const key = `${pre.forNode}->${pre.required}`;
    if (!merged.has(key)) merged.set(key, pre);
  }
  return [...merged.values()].sort((a, b) => a.depth - b.depth);
}

function pathProbability(steps: PathStep[]): number {
  return steps.reduce((acc, s) => acc * s.successRatio, 1);
}

function pathDuration(steps: PathStep[]): number {
  return steps.reduce((acc, s) => acc + s.expectedDurationSec, 0);
}

export function getGuidance(
  store: ProcedureStore,
  opts: {
    current?: string;
    goal?: string;
    env?: string;
    lastAction?: string;
    hops?: number;
    trajectory?: string[];
    query?: string;
  } = {},
): Guidance {
  const warnings: string[] = [];

  // Accept both local names and full IRIs from every caller (CLI, MCP, tests).
  const requestedCurrent = opts.current ? resolveIri(opts.current, PG) : undefined;
  const goal = opts.goal ? resolveIri(opts.goal, PG) : undefined;

  let localized: Guidance["localized"] = null;
  let currentIri = requestedCurrent ?? null;
  if (!currentIri && opts.lastAction) {
    const match = localize(store, opts.lastAction);
    if (match) {
      localized = { iri: match.iri, matchedBy: match.matchedBy };
      currentIri = match.iri;
    } else {
      warnings.push(
        `No node matched "${opts.lastAction}"; falling back to the full graph.`,
      );
    }
  }

  const nb = neighborhood(store, currentIri, opts.hops ?? DEFAULT_HOPS);
  const guidanceText = serializeGuidance(store, nb, {
    query: opts.query,
    trajectory: opts.trajectory,
    goal,
  });

  const current = currentIri ? nodeDetails(store, currentIri) : null;
  const steps = currentIri ? nextSteps(store, currentIri, opts.env) : [];
  const prerequisites = currentIri ? prerequisitesFor(store, [currentIri]) : [];

  for (const s of steps) {
    if (s.attempts > 0 && s.successRatio < 0.5) {
      warnings.push(
        `Edge ${currentIri} -> ${s.iri} failed ${Math.round(
          (1 - s.successRatio) * 100,
        )}% of observed runs (${s.attempts} attempts).`,
      );
    }
  }

  let fastestPath: Guidance["fastestPath"] = null;
  if (currentIri && goal) {
    const path = findFastestPath(store, currentIri, goal);
    if (path) {
      fastestPath = {
        from: currentIri,
        to: goal,
        steps: path,
        prerequisites: mergePrerequisites(
          path,
          prerequisitesFor(store, [currentIri, ...path.map((s) => s.to)]),
        ),
        totalExpectedSec: pathDuration(path),
        pathSuccessProbability: pathProbability(path),
      };
    } else {
      warnings.push(`No precedes-path found from ${currentIri} to ${goal}.`);
    }
  }

  let entries: Guidance["entryPoints"] = [];
  if (!currentIri && goal) {
    entries = entryPoints(store)
      .map((start) => {
        const path = findFastestPath(store, start, goal);
        if (!path) return null;
        return {
          iri: start,
          name: String(nodeDetails(store, start).name),
          totalExpectedSec: pathDuration(path),
          pathSuccessProbability: pathProbability(path),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.totalExpectedSec - b.totalExpectedSec)
      .slice(0, 5);
  }

  return {
    localized,
    current,
    guidanceText,
    neighborhood: nb,
    nextSteps: steps,
    prerequisites,
    fastestPath,
    entryPoints: entries,
    warnings,
  };
}

export interface GraphStats {
  procedures: number;
  edges: number;
  runs: number;
  rollouts: number;
  proposals: number;
  successRate: number;
  retiredEdges: number;
  slowestEdges: Array<{
    edge: string;
    attempts: number;
    avgDurationSec: number;
    successRatio: number;
  }>;
  failingEdges: Array<{ edge: string; attempts: number; successRatio: number }>;
}

export function getStats(store: ProcedureStore): GraphStats {
  const count = (sparql: string, key: string): number => {
    const rows = store.select(sparql);
    return rows.length ? Number(rows[0][key]?.value ?? 0) : 0;
  };
  const procedures = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?p) AS ?c) WHERE { ?p a pg:Procedure }`,
    "c",
  );
  const edges = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?e) AS ?c) WHERE { ?e a pg:Edge }`,
    "c",
  );
  const retiredEdges = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?e) AS ?c) WHERE { ?e a pg:Edge ; pg:status "retired" }`,
    "c",
  );
  const runs = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?r) AS ?c) WHERE { ?r a pg:Run }`,
    "c",
  );
  const rollouts = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?r) AS ?c) WHERE { ?r a pg:Rollout }`,
    "c",
  );
  const proposals = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?p) AS ?c) WHERE { ?p a pg:Proposal }`,
    "c",
  );
  const successes = count(
    `PREFIX pg: <${PG}> SELECT (COUNT(?r) AS ?c) WHERE { ?r a pg:Run ; pg:outcome "success" }`,
    "c",
  );
  const observed = loadEdges(store).filter((e) => e.successCount + e.failCount > 0);
  return {
    procedures,
    edges,
    runs,
    rollouts,
    proposals,
    successRate: runs > 0 ? successes / runs : 0,
    retiredEdges,
    slowestEdges: observed
      .filter((e) => e.avgDurationSec > 0)
      .sort((a, b) => b.avgDurationSec - a.avgDurationSec)
      .slice(0, 5)
      .map((e) => ({
        edge: e.edgeIri,
        attempts: e.successCount + e.failCount,
        avgDurationSec: e.avgDurationSec,
        successRatio: e.successRatio,
      })),
    failingEdges: observed
      .filter((e) => e.failCount > 0)
      .sort((a, b) => a.successRatio - b.successRatio)
      .slice(0, 5)
      .map((e) => ({
        edge: e.edgeIri,
        attempts: e.successCount + e.failCount,
        successRatio: e.successRatio,
      })),
  };
}

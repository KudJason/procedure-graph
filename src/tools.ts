/**
 * MCP tool surface for the procedural graph.
 *
 * Read side  (online inference): localization + neighborhood guidance.
 * Write side (self-evolution)  : outcome recording, rollout evidence,
 *                                edit proposals, the validation gate and
 *                                rejection memory.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProcedureStore, resolveIri } from "./store.js";
import { getGuidance, getStats, neighborhood, localize } from "./guidance.js";
import { findFastestPath, nodeDetails, nodeLabel } from "./pathfinder.js";
import { ensureProcedure, ensureEdge, recordOutcome, retireEdge, activateEdge } from "./evolution.js";
import {
  recordRollout,
  listRollouts,
  proposeEdits,
  validateProposal,
  rejectionMemory,
  listProposals,
  refineContext,
  evaluateGraph,
  type EditOp,
} from "./evolution_loop.js";
import { importEvidence, loadBundles } from "./evidence.js";
import { PG } from "./ontology.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const iri = (value: string): string =>
  value.startsWith("http://") || value.startsWith("https://") ? value : PG + value;

const editOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_edge"),
    from: z.string(),
    to: z.string(),
    relation: z.enum(["precedes", "requires", "alternativeOf", "substepOf", "repairs"]).optional(),
    condition: z.string().optional(),
    guidance: z.string().optional(),
    pitfalls: z.string().optional(),
    guard: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal("delete_edge"),
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal("add_node"),
    localName: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    command: z.string().optional(),
    docRef: z.string().optional(),
    env: z.string().optional(),
    risk: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal("update_edge_attributes"),
    from: z.string(),
    to: z.string(),
    condition: z.string().optional(),
    guidance: z.string().optional(),
    pitfalls: z.string().optional(),
    guard: z.boolean().optional(),
    reason: z.string().optional(),
  }),
]);

export function listProcedures(store: ProcedureStore, env?: string): unknown[] {
  const rows = store.select(`
    PREFIX pg: <${PG}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?p ?label ?env ?kind ?command WHERE {
      ?p a pg:Procedure ; rdfs:label ?label .
      OPTIONAL { ?p pg:env ?env }
      OPTIONAL { ?p pg:kind ?kind }
      OPTIONAL { ?p pg:command ?command }
    } ORDER BY ?label
  `);
  return rows
    .filter((r) => {
      if (!env) return true;
      const nodeEnv = r.env?.value;
      return !nodeEnv || nodeEnv === "any" || nodeEnv === env;
    })
    .map((r) => ({
      iri: r.p!.value,
      localName: r.p!.value.split("#").pop(),
      name: r.label?.value,
      kind: r.kind?.value,
      env: r.env?.value,
      command: r.command?.value,
    }));
}

export function listRuns(store: ProcedureStore, limit = 20): unknown[] {
  const rows = store.select(`
    PREFIX pg: <${PG}>
    SELECT ?run ?edge ?outcome ?duration ?ts ?actor ?notes WHERE {
      ?run a pg:Run ; pg:runOf ?edge ; pg:outcome ?outcome ; pg:timestamp ?ts .
      OPTIONAL { ?run pg:durationSec ?duration }
      OPTIONAL { ?run pg:actor ?actor }
      OPTIONAL { ?run pg:notes ?notes }
    } ORDER BY DESC(?ts) LIMIT ${Math.max(1, Math.min(200, limit))}
  `);
  return rows.map((r) => ({
    run: r.run!.value,
    edge: r.edge!.value,
    outcome: r.outcome!.value,
    durationSec: r.duration ? Number(r.duration.value) : undefined,
    timestamp: r.ts?.value,
    actor: r.actor?.value,
    notes: r.notes?.value,
  }));
}

export function registerTools(server: McpServer, store: ProcedureStore): void {
  // ---------------------------------------------------------------------
  // Online inference
  // ---------------------------------------------------------------------

  server.registerTool(
    "pg_guidance",
    {
      title: "Procedural graph guidance",
      description:
        "Online guidance (paper Sec 3.2): localize the active node from the last action, extract its h=2-hop neighborhood, and return serialized situational guidance plus ranked next steps and the fastest successful path to a goal. Call before starting a workflow.",
      inputSchema: {
        lastAction: z
          .string()
          .optional()
          .describe("Most recent action/tool call, e.g. 'git push' or 'git-push'"),
        current: z.string().optional().describe("Explicit current procedure (IRI or local name)"),
        goal: z.string().optional().describe("Target procedure, e.g. smoke-test-api"),
        env: z.enum(["dev", "staging", "prod", "any"]).optional(),
        hops: z.number().optional().describe("Neighborhood expansion depth (default 2)"),
        trajectory: z
          .array(z.string())
          .optional()
          .describe("Recent trajectory window (paper: last w=3 steps)"),
        query: z.string().optional().describe("Current task description"),
      },
    },
    async (args) =>
      text(
        getGuidance(store, {
          lastAction: args.lastAction,
          current: args.current ? iri(args.current) : undefined,
          goal: args.goal ? iri(args.goal) : undefined,
          env: args.env,
          hops: args.hops,
          trajectory: args.trajectory,
          query: args.query,
        }),
      ),
  );

  server.registerTool(
    "pg_localize",
    {
      title: "Localize active node",
      description:
        "Match an action string to a procedure node (exact local name, then label, then command). Returns null when nothing matches — callers then use the full graph.",
      inputSchema: { lastAction: z.string() },
    },
    async ({ lastAction }) => text({ match: localize(store, lastAction) }),
  );

  server.registerTool(
    "pg_neighborhood",
    {
      title: "Procedural subgraph",
      description:
        "Return the h-hop outgoing neighborhood of a node (or of Start) with the paper's edge attributes.",
      inputSchema: { iri: z.string().optional(), hops: z.number().optional() },
    },
    async ({ iri: target, hops }) =>
      text(neighborhood(store, target ? iri(target) : null, hops ?? 2)),
  );

  server.registerTool(
    "pg_find_path",
    {
      title: "Fastest successful path",
      description:
        "Fastest path between two procedures, weighted by observed success ratios and durations.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
      },
    },
    async ({ from, to }) => {
      const f = iri(from);
      const t = iri(to);
      const path = findFastestPath(store, f, t);
      return text({
        from: f,
        to: t,
        found: path !== null,
        steps: path ?? [],
        totalExpectedSec: path ? path.reduce((a, s) => a + s.expectedDurationSec, 0) : null,
        pathSuccessProbability: path ? path.reduce((a, s) => a * s.successRatio, 1) : null,
      });
    },
  );

  server.registerTool(
    "pg_procedure",
    {
      title: "Procedure detail",
      description: "Show one procedure's command, docs, and ranked outgoing next steps.",
      inputSchema: { iri: z.string() },
    },
    async ({ iri: target }) => {
      const full = iri(target);
      const rows = getGuidance(store, { current: full });
      return text({ details: rows.current, nextSteps: rows.nextSteps });
    },
  );

  server.registerTool(
    "pg_list_procedures",
    {
      title: "List procedures",
      description: "List all procedure nodes.",
      inputSchema: { env: z.string().optional() },
    },
    async ({ env }) => text(listProcedures(store, env)),
  );

  // ---------------------------------------------------------------------
  // Self-evolution
  // ---------------------------------------------------------------------

  server.registerTool(
    "pg_record_outcome",
    {
      title: "Record step outcome",
      description:
        "Record whether a transition succeeded, with duration and notes. Updates edge statistics so guidance prefers the fastest successful path.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        outcome: z.enum(["success", "failure"]),
        durationSec: z.number().optional(),
        notes: z.string().optional(),
        actor: z.string().optional(),
      },
    },
    async (args) => {
      const result = recordOutcome(store, args);
      store.save();
      return text({ ...result, savedTo: store.graphFile });
    },
  );

  server.registerTool(
    "pg_record_rollout",
    {
      title: "Record diagnostic rollout",
      description:
        "Step 1 of the self-evolution loop: store a full trajectory with its task score. split=train feeds the refiner contrast; split=val feeds the validation gate.",
      inputSchema: {
        task: z.string(),
        steps: z.array(z.string()).describe("Ordered procedure local names or IRIs"),
        score: z.number().describe("Final task score in [0,1]"),
        split: z.enum(["train", "val"]),
        actor: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (args) => {
      const result = recordRollout(store, args);
      store.save();
      return text({ ...result, validationScore: evaluateGraph(store).score });
    },
  );

  server.registerTool(
    "pg_record_step_outcome",
    {
      title: "Alias of pg_record_outcome",
      description: "Deprecated alias kept for convenience.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        outcome: z.enum(["success", "failure"]),
        durationSec: z.number().optional(),
        notes: z.string().optional(),
        actor: z.string().optional(),
      },
    },
    async (args) => {
      const result = recordOutcome(store, args);
      store.save();
      return text(result);
    },
  );

  server.registerTool(
    "pg_refine_context",
    {
      title: "Refiner input bundle",
      description:
        "Step 2/4 input: contrasts successful vs failed traces, lists failure-prone edges, and returns the rejection memory so the next proposal avoids repeat mistakes.",
      inputSchema: { trainLimit: z.number().optional() },
    },
    async ({ trainLimit }) => text(refineContext(store, { trainLimit })),
  );

  server.registerTool(
    "pg_propose_edits",
    {
      title: "Propose graph edits",
      description:
        "Step 2: stage a candidate edit set (add_edge / delete_edge / add_node / update_edge_attributes). Runs the structural checks on a copy (self-loop and cycle repair) without touching the retained graph.",
      inputSchema: {
        summary: z.string(),
        edits: z.array(editOpSchema),
        actor: z.string().optional(),
      },
    },
    async ({ summary, edits, actor }) => {
      const result = proposeEdits(store, {
        summary,
        edits: edits as EditOp[],
        actor,
      });
      store.save();
      return text(result);
    },
  );

  server.registerTool(
    "pg_validate_proposal",
    {
      title: "Validation gate",
      description:
        "Step 3: evaluate the candidate on held-out rollouts (split=val). Commits only when the score does not decrease; otherwise rejects it into the rejection memory. Returns pending when no validation evidence exists yet.",
      inputSchema: { proposalIri: z.string() },
    },
    async ({ proposalIri }) => {
      const result = validateProposal(store, { proposalIri });
      store.save();
      return text(result);
    },
  );

  server.registerTool(
    "pg_rejection_memory",
    {
      title: "Rejection memory",
      description:
        "Step 4: rejected candidates with their edits and reasons — negative evidence for the refiner.",
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit }) => text(rejectionMemory(store, limit ?? 10)),
  );

  server.registerTool(
    "pg_list_proposals",
    {
      title: "List proposals",
      description: "All edit proposals with status and validation scores.",
      inputSchema: { status: z.enum(["pending", "committed", "rejected"]).optional() },
    },
    async ({ status }) => text(listProposals(store, status)),
  );

  server.registerTool(
    "pg_list_rollouts",
    {
      title: "List rollouts",
      description: "Recorded trajectories and scores.",
      inputSchema: {
        split: z.enum(["train", "val"]).optional(),
        limit: z.number().optional(),
      },
    },
    async ({ split, limit }) => text(listRollouts(store, { split, limit })),
  );

  server.registerTool(
    "pg_add_procedure",
    {
      title: "Add or patch a procedure",
      description: "Refiner operation: create or update a procedure node.",
      inputSchema: {
        localName: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        command: z.string().optional(),
        docRef: z.string().optional(),
        env: z.string().optional(),
        risk: z.string().optional(),
      },
    },
    async (input) => {
      const result = ensureProcedure(store, { ...input, name: input.name ?? input.localName });
      store.save();
      return text({ iri: result });
    },
  );

  server.registerTool(
    "pg_add_edge",
    {
      title: "Add or patch an edge",
      description:
        "Refiner operation: connect two procedures with a relation plus optional condition/guidance/pitfalls attributes.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        relation: z.enum(["precedes", "requires", "alternativeOf", "substepOf", "repairs"]).optional(),
        condition: z.string().optional(),
        guidance: z.string().optional(),
        pitfalls: z.string().optional(),
      },
    },
    async ({ from, to, relation, condition, guidance, pitfalls }) => {
      const result = ensureEdge(store, {
        from,
        to,
        relation: relation ? PG + relation : undefined,
        condition,
        guidance,
        pitfalls,
      });
      store.save();
      return text({ edgeIri: result });
    },
  );

  server.registerTool(
    "pg_retire_edge",
    {
      title: "Retire or restore an edge",
      description:
        "Retire a permanently bad edge (excluded from pathfinding, kept as history) or restore it.",
      inputSchema: {
        edgeIri: z.string(),
        status: z.enum(["retired", "active"]).optional(),
      },
    },
    async ({ edgeIri: target, status }) => {
      const full = iri(target);
      if ((status ?? "retired") === "retired") retireEdge(store, full);
      else activateEdge(store, full);
      store.save();
      return text({ edgeIri: full, status: status ?? "retired" });
    },
  );

  server.registerTool(
    "pg_import_evidence",
    {
      title: "Bulk-import historical evidence",
      description:
        "Load historical execution records (deploy logs, test reports, QA sessions, E2E logs) into the graph as procedures, attributed edges, outcomes and rollouts. Idempotent: the same bundle can be re-imported without double-counting.",
      inputSchema: {
        file: z.string().describe("Path to a bundle JSON file or a directory of *.json bundles"),
        dedupe: z.boolean().optional().describe("Skip records already imported (default true)"),
      },
    },
    async ({ file, dedupe }) => {
      const { bundles, files } = loadBundles(file);
      const report = importEvidence(store, bundles, { dedupe });
      store.save();
      return text({ ...report, loadedFiles: files, validationScore: evaluateGraph(store).score });
    },
  );

  server.registerTool(
    "pg_stats",
    {
      title: "Graph statistics",
      description:
        "Totals plus the slowest and most failure-prone edges — the refiner's priority list.",
      inputSchema: {},
    },
    async () => text(getStats(store)),
  );

  server.registerTool(
    "pg_list_runs",
    {
      title: "Recent step runs",
      description: "Recent per-transition outcome provenance.",
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit }) => text(listRuns(store, limit ?? 20)),
  );

  void resolveIri;
  void nodeDetails;
  void nodeLabel;
}

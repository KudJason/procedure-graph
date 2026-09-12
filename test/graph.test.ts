import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcedureStore, SEED_FILE } from "../src/store.js";
import { getGuidance, localize, neighborhood, nextSteps, serializeGuidance } from "../src/guidance.js";
import { findFastestPath, loadEdges } from "../src/pathfinder.js";
import { recordOutcome, ensureProcedure, ensureEdge } from "../src/evolution.js";
import { evaluateGraph, proposeEdits, recordRollout, validateProposal } from "../src/evolution_loop.js";
import { PG, START_IRI } from "../src/ontology.js";

function freshStore(): ProcedureStore {
  const dir = mkdtempSync(join(tmpdir(), "procedure-graph-test-"));
  return new ProcedureStore(join(dir, "graph.nq"), SEED_FILE);
}

const node = (name: string): string => PG + name;

test("generic seed loads with a Start marker and attributed edges", () => {
  const store = freshStore();
  const procedures = store.select(`PREFIX pg: <${PG}> SELECT ?p WHERE { ?p a pg:Procedure }`);
  assert.ok(procedures.length >= 8);
  assert.ok(procedures.some((row) => row.p?.value === START_IRI));
  const edges = loadEdges(store);
  assert.ok(edges.length >= 7);
  assert.ok(edges.some((edge) => edge.guidance));
});

test("localize matches names, labels and commands", () => {
  const store = freshStore();
  assert.equal(localize(store, "define-scope")?.iri, node("define-scope"));
  assert.equal(localize(store, "Define scope")?.iri, node("define-scope"));
  assert.equal(localize(store, "git push")?.iri, node("publish-change"));
  assert.equal(localize(store, "unknown action"), null);
});

test("guidance returns a neighborhood and fastest path", () => {
  const store = freshStore();
  const result = getGuidance(store, { lastAction: "define-scope", goal: "publish-change" });
  assert.equal(result.localized?.iri, node("define-scope"));
  assert.ok(result.nextSteps.length > 0);
  assert.equal(result.fastestPath?.to, node("publish-change"));
  assert.match(serializeGuidance(store, neighborhood(store, node("define-scope"), 2), {}), /guidance:/);
});

test("pathfinding follows precedes transitions", () => {
  const path = findFastestPath(freshStore(), node("define-scope"), node("publish-change"));
  assert.ok(path);
  assert.equal(path?.at(-1)?.to, node("publish-change"));
});

test("outcomes re-rank unreliable transitions", () => {
  const store = freshStore();
  ensureProcedure(store, { localName: "fast-option", name: "Fast option" });
  ensureEdge(store, { from: "define-scope", to: "fast-option", relation: "precedes" });
  for (let i = 0; i < 4; i++) {
    recordOutcome(store, { from: "define-scope", to: "implement-change", outcome: "failure", durationSec: 100 });
    recordOutcome(store, { from: "define-scope", to: "fast-option", outcome: "success", durationSec: 5 });
  }
  assert.equal(nextSteps(store, node("define-scope"))[0].iri, node("fast-option"));
});

test("validation gate rejects a harmful candidate", () => {
  const store = freshStore();
  recordRollout(store, {
    task: "generic development flow",
    steps: ["define-scope", "implement-change", "update-tests", "run-checks"],
    score: 1,
    split: "val",
  });
  const before = evaluateGraph(store).score;
  assert.equal(before, 1);
  const { proposalIri } = proposeEdits(store, {
    summary: "remove the expected verification step",
    edits: [
      { op: "delete_edge", from: "define-scope", to: "implement-change" },
      { op: "delete_edge", from: "implement-change", to: "update-tests" },
      { op: "delete_edge", from: "update-tests", to: "run-checks" },
    ],
  });
  const result = validateProposal(store, { proposalIri });
  assert.equal(result.status, "pending");
  assert.equal(result.validationAfter, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcedureStore, SEED_FILE } from "../src/store.js";
import { ensureEdge } from "../src/evolution.js";
import { findFastestPath, loadEdges } from "../src/pathfinder.js";
import { PG } from "../src/ontology.js";

test("guard edges stay visible but cannot create a default shortcut", () => {
  const store = new ProcedureStore(join(mkdtempSync(join(tmpdir(), "pg-guard-")), "graph.nq"), SEED_FILE);
  ensureEdge(store, { from: "define-scope", to: "publish-change", relation: "precedes", guard: true, condition: "Only after an explicit exception" });
  const guarded = loadEdges(store).find((edge) => edge.from === PG + "define-scope" && edge.to === PG + "publish-change");
  assert.equal(guarded?.guard, true);
  const normalPath = findFastestPath(store, PG + "define-scope", PG + "publish-change");
  assert.ok(normalPath);
  assert.ok(normalPath!.length > 1, "default path must retain the normal gates");
});

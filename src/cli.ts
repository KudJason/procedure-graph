#!/usr/bin/env node
/**
 * CLI for the procedural graph — same operations as the MCP tools, for humans
 * and for shell-based agents.
 *
 *   yarn cli guidance --last "git push" --goal smoke-test-api
 *   yarn cli path define-scope smoke-test-api
 *   yarn cli rollout --task deploy-dev --steps a,b,c --score 1 --split val
 *   yarn cli propose --file edits.json
 *   yarn cli validate pg:proposal-...
 *   yarn cli refine | rejections | stats | list | runs | reset
 */
import { readFileSync, rmSync, existsSync } from "node:fs";
import { ProcedureStore, GRAPH_FILE, SEED_FILE, resolveIri } from "./store.js";
import { getGuidance, getStats } from "./guidance.js";
import { findFastestPath, nodeLabel } from "./pathfinder.js";
import { recordOutcome } from "./evolution.js";
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
import { listProcedures, listRuns } from "./tools.js";
import { importEvidence, loadBundles } from "./evidence.js";
import { PG } from "./ontology.js";

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const args = positional(rest);

  if (flags.reset === "true" || command === "reset") {
    if (existsSync(GRAPH_FILE)) rmSync(GRAPH_FILE);
    const fresh = new ProcedureStore(GRAPH_FILE, SEED_FILE);
    fresh.save();
    print({ reset: true, quads: fresh.size(), from: SEED_FILE });
    return;
  }

  const store = new ProcedureStore(GRAPH_FILE, SEED_FILE);

  switch (command) {
    case "guidance": {
      const result = getGuidance(store, {
        lastAction: flags.last,
        current: flags.current ? resolveIri(flags.current, PG) : undefined,
        goal: flags.goal ? resolveIri(flags.goal, PG) : undefined,
        env: flags.env,
        query: flags.query,
      });
      print(result.guidanceText);
      console.log("\n--- ranked next steps ---");
      print(result.nextSteps);
      if (result.fastestPath) {
        console.log("\n--- fastest successful path ---");
        print({
          totalExpectedSec: result.fastestPath.totalExpectedSec,
          pathSuccessProbability: result.fastestPath.pathSuccessProbability,
          prerequisites: result.fastestPath.prerequisites.map(
            (p) => `${p.required.split("#").pop()} (before ${p.forNode.split("#").pop()})`,
          ),
          steps: result.fastestPath.steps.map((s) => ({
            to: s.to.split("#").pop(),
            expectedDurationSec: s.expectedDurationSec,
            successRatio: Number(s.successRatio.toFixed(3)),
            condition: s.condition,
          })),
        });
      }
      if (result.warnings.length) {
        console.log("\n--- warnings ---");
        print(result.warnings);
      }
      break;
    }
    case "path": {
      const [from, to] = args;
      if (!from || !to) throw new Error("usage: cli path <from> <to>");
      const path = findFastestPath(store, resolveIri(from, PG), resolveIri(to, PG));
      if (!path) {
        print({ found: false });
        break;
      }
      // Prerequisite steps are requirements (B before A); ordering steps are
      // literal transitions. Render them differently so the order is unambiguous.
      print({
        totalExpectedSec: path.reduce((a, s) => a + s.expectedDurationSec, 0),
        pathSuccessProbability: path.reduce((a, s) => a * s.successRatio, 1),
        steps: path.map((s, i) =>
          s.isPrerequisite
            ? `${i + 1}. [prereq] ${s.to.split("#").pop()} (required before ${s.from.split("#").pop()})`
            : `${i + 1}. ${s.from.split("#").pop()} -> ${s.to.split("#").pop()}`,
        ),
      });
      break;
    }
    case "list":
      print(listProcedures(store, flags.env));
      break;
    case "node": {
      const [target] = args;
      if (!target) throw new Error("usage: cli node <local-name>");
      const full = resolveIri(target, PG);
      print({
        name: nodeLabel(store, full),
        outgoing: getGuidance(store, { current: full }).nextSteps,
      });
      break;
    }
    case "stats":
      print({ ...getStats(store), validationScore: evaluateGraph(store).score });
      break;
    case "runs":
      print(listRuns(store, flags.limit ? Number(flags.limit) : 20));
      break;
    case "outcome": {
      if (!flags.from || !flags.to || !flags.outcome) {
        throw new Error("usage: cli outcome --from <a> --to <b> --outcome success|failure [--duration 12]");
      }
      const result = recordOutcome(store, {
        from: flags.from,
        to: flags.to,
        outcome: flags.outcome as "success" | "failure",
        durationSec: flags.duration ? Number(flags.duration) : undefined,
        notes: flags.notes,
        actor: flags.actor ?? "cli",
      });
      store.save();
      print(result);
      break;
    }
    case "rollout": {
      if (!flags.task || !flags.steps || flags.score === undefined) {
        throw new Error(
          "usage: cli rollout --task <name> --steps a,b,c --score 0.9 [--split train|val]",
        );
      }
      const result = recordRollout(store, {
        task: flags.task,
        steps: flags.steps.split(",").map((s) => s.trim()),
        score: Number(flags.score),
        split: (flags.split as "train" | "val") ?? "train",
        actor: flags.actor ?? "cli",
        notes: flags.notes,
      });
      store.save();
      print({ ...result, validationScore: evaluateGraph(store).score });
      break;
    }
    case "rollouts":
      print(listRollouts(store, { split: flags.split as "train" | "val" | undefined }));
      break;
    case "import": {
      if (!flags.file) throw new Error("usage: cli import --file <bundle.json|dir> [--no-dedupe]");
      const { bundles, files } = loadBundles(flags.file);
      const result = importEvidence(store, bundles, { dedupe: flags["no-dedupe"] !== "true" });
      store.save();
      print({ ...result, files });
      break;
    }
    case "refine":
      print(refineContext(store));
      break;
    case "propose": {
      if (!flags.file) throw new Error("usage: cli propose --file <edits.json> [--summary text]");
      const raw = JSON.parse(readFileSync(flags.file, "utf-8")) as
        | EditOp[]
        | { summary: string; edits: EditOp[] };
      const payload = Array.isArray(raw) ? { summary: "cli proposal", edits: raw } : raw;
      const result = proposeEdits(store, { ...payload, actor: flags.actor ?? "cli" });
      store.save();
      print(result);
      break;
    }
    case "validate": {
      const [target] = args;
      if (!target) throw new Error("usage: cli validate <proposal-iri>");
      const result = validateProposal(store, { proposalIri: target });
      store.save();
      print(result);
      break;
    }
    case "proposals":
      print(listProposals(store, flags.status));
      break;
    case "rejections":
      print(rejectionMemory(store, flags.limit ? Number(flags.limit) : 10));
      break;
    default:
      console.log(
        [
          "procedure-graph CLI",
          "",
          "  guidance --last <action> [--goal <node>] [--env dev|staging|prod]",
          "  path <from> <to>",
          "  list [--env <env>] | node <name> | stats | runs [--limit n]",
          "  outcome --from <a> --to <b> --outcome success|failure [--duration n]",
          "  rollout --task <name> --steps a,b,c --score 0.9 [--split train|val]",
          "  rollouts [--split val]",
          "  import --file <bundle.json|dir>   (bulk-load historical evidence)",
          "  refine | propose --file edits.json | validate <proposal> | proposals | rejections",
          "  reset   (drop graph.nq and reload the seed graph)",
        ].join("\n"),
      );
  }
}

main();

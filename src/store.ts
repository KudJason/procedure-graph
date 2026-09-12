/**
 * Triple store wrapper: oxigraph in-memory store with file persistence.
 *
 * Two data files:
 *  - data/seed-procedures.ttl : human-editable seed graph (read at bootstrap
 *    when the working graph does not exist yet)
 *  - data/graph.nq            : working state, auto-saved in N-Quads
 *    (oxigraph Store.dump only supports dataset formats)
 */
import * as oxi from "oxigraph";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = new URL("../", import.meta.url).pathname;
export const SEED_FILE = BASE + "data/seed-procedures.ttl";
export const GRAPH_FILE = BASE + "data/graph.nq";

export interface TermValue {
  value: string;
  termType?: string;
}

export interface Binding {
  [variable: string]: TermValue | undefined;
}

export class ProcedureStore {
  private store: oxi.Store;
  public graphFile: string;
  public seedFile: string;

  constructor(graphFile: string = GRAPH_FILE, seedFile: string = SEED_FILE) {
    this.graphFile = graphFile;
    this.seedFile = seedFile;
    this.store = new oxi.Store();
    if (existsSync(graphFile)) {
      this.store.load(readFileSync(graphFile, "utf-8"), {
        format: "application/n-quads",
      });
    } else if (existsSync(seedFile)) {
      this.store.load(readFileSync(seedFile, "utf-8"), {
        format: "text/turtle",
      });
    }
  }

  /** Run a SPARQL SELECT; returns plain JS bindings (var name -> {value, termType}). */
  select(sparql: string): Binding[] {
    const results = this.store.query(sparql) as Array<Map<string, oxi.Term>>;
    if (!Array.isArray(results)) return [];
    return results.map((binding) => {
      const out: Binding = {};
      for (const [k, v] of binding.entries()) {
        out[k] = { value: v.value, termType: v.termType };
      }
      return out;
    });
  }

  /** Run a SPARQL UPDATE (INSERT/DELETE). */
  update(sparql: string): void {
    this.store.update(sparql);
  }

  /** Persist the working graph to N-Quads. */
  save(): void {
    const nq = this.store.dump({ format: "application/n-quads" }) as string;
    mkdirSync(dirname(this.graphFile), { recursive: true });
    writeFileSync(this.graphFile, nq, "utf-8");
  }

  /** Number of quads, for sanity checks. */
  size(): number {
    const rows = this.select(
      "SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }",
    );
    return rows.length ? Number(rows[0].c?.value ?? 0) : 0;
  }

  /** All quads (rarely needed; used by stats/debug). */
  matchAll(): oxi.Quad[] {
    return this.store.match(null, null, null, null) as oxi.Quad[];
  }

  /** Serialize the store as N-Quads (used for candidate-graph copies). */
  dumpNQuads(): string {
    return this.store.dump({ format: "application/n-quads" }) as string;
  }

  /** Load quads from an N-Quads string. */
  loadNQuads(text: string): void {
    if (text.trim()) {
      this.store.load(text, { format: "application/n-quads" });
    }
  }

  /** Deep copy of this store (candidate graphs are edited on a copy). */
  clone(target: ProcedureStore): ProcedureStore {
    target.loadNQuads(this.dumpNQuads());
    return target;
  }
}

/** Accept "git-push" or a full IRI; always returns the full procedure IRI. */
export function resolveIri(input: string, base: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) return input;
  return base + input.replace(/^:/, "");
}

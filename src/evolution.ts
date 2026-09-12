/**
 * Self-evolution operations (arXiv 2609.09153):
 *  - every executed step records a Run with outcome provenance
 *  - edge stats (success/fail counts, avg duration) are updated incrementally
 *  - the refiner can add or retire edges/procedures to reshape the topology
 */
import { ProcedureStore, resolveIri } from "./store.js";
import {
  PG,
  C_EDGE,
  C_RUN,
  C_PROCEDURE,
  P_FROM,
  P_TO,
  P_RELATION,
  P_CONDITION,
  P_GUIDANCE,
  P_PITFALLS,
  P_PRECEDES,
  P_NAME,
  P_KIND,
  P_DESCRIPTION,
  P_COMMAND,
  P_DOC_REF,
  P_ENV,
  P_RISK,
  P_GUARD,
  P_SUCCESS_COUNT,
  P_FAIL_COUNT,
  P_AVG_DURATION_SEC,
  P_RUN_OF,
  P_OUTCOME,
  P_DURATION_SEC,
  P_TIMESTAMP,
  P_NOTES,
  P_ACTOR,
  P_STATUS,
  P_UPDATED_AT,
  P_EVIDENCE_KEY,
  STATUS_ACTIVE,
  STATUS_RETIRED,
} from "./ontology.js";

export interface ProcedureInput {
  localName: string;
  name?: string;
  description?: string;
  command?: string;
  docRef?: string;
  env?: string;
  risk?: string;
  /** tool | skill | reasoning | status (paper Sec. 3.1 node kinds). */
  kind?: string;
}

export interface EdgeInput {
  from: string;
  to: string;
  relation?: string;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
  /** Safety/fallback edge excluded from pathfinding unless explicitly enabled. */
  guard?: boolean;
}

export interface OutcomeInput {
  from: string;
  to: string;
  outcome: "success" | "failure";
  durationSec?: number;
  notes?: string;
  actor?: string;
  /** Idempotency key: importing the same historical record twice is a no-op. */
  evidenceKey?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newRunIri(): string {
  return PG + "run/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

function localPart(iri: string): string {
  return iri.split("#").pop() ?? iri;
}

export function edgeIriFor(fromIri: string, toIri: string): string {
  // Hyphen form keeps the IRI usable as a prefixed name (pg:edge-a-b).
  return (PG + "edge-" + localPart(fromIri) + "-" + localPart(toIri)).toLowerCase();
}

export { edgeIriFor as edgeIri };

/** Idempotently create/patch a procedure node. */
export function ensureProcedure(
  store: ProcedureStore,
  input: ProcedureInput,
): string {
  const iri = resolveIri(input.localName, PG);
  const triples: string[] = [
    `<${iri}> a <${C_PROCEDURE}> ; <${P_NAME}> ${JSON.stringify(
      input.name ?? localPart(iri),
    )} .`,
  ];
  if (input.description)
    triples.push(`<${iri}> <${P_DESCRIPTION}> ${JSON.stringify(input.description)} .`);
  if (input.command)
    triples.push(`<${iri}> <${P_COMMAND}> ${JSON.stringify(input.command)} .`);
  if (input.docRef)
    triples.push(`<${iri}> <${P_DOC_REF}> ${JSON.stringify(input.docRef)} .`);
  if (input.env) triples.push(`<${iri}> <${P_ENV}> ${JSON.stringify(input.env)} .`);
  if (input.kind) triples.push(`<${iri}> <${P_KIND}> ${JSON.stringify(input.kind)} .`);
  if (input.risk)
    triples.push(`<${iri}> <${P_RISK}> ${JSON.stringify(input.risk)} .`);
  triples.push(`<${iri}> <${P_UPDATED_AT}> ${JSON.stringify(nowIso())} .`);
  store.update(
    `PREFIX pg: <${PG}>\nINSERT DATA {\n  ${triples.join("\n  ")}\n}`,
  );
  return iri;
}

/** Idempotently create an edge; returns its IRI. Existing edges are patched. */
export function ensureEdge(store: ProcedureStore, input: EdgeInput): string {
  const fromIri = resolveIri(input.from, PG);
  const toIri = resolveIri(input.to, PG);
  // Accept both a full relation IRI and a bare name such as "requires".
  const relation = input.relation
    ? input.relation.startsWith("http")
      ? input.relation
      : PG + input.relation
    : P_PRECEDES;
  const edgeIri = edgeIriFor(fromIri, toIri);
  store.update(
    `PREFIX pg: <${PG}>
INSERT DATA {
  <${edgeIri}> a <${C_EDGE}> ;
    <${P_FROM}> <${fromIri}> ;
    <${P_TO}> <${toIri}> ;
    <${P_SUCCESS_COUNT}> 0 ;
    <${P_FAIL_COUNT}> 0 ;
    <${P_AVG_DURATION_SEC}> 0 ;
    <${P_STATUS}> ${JSON.stringify(STATUS_ACTIVE)} .
  <${fromIri}> a <${C_PROCEDURE}> .
  <${toIri}> a <${C_PROCEDURE}> .
}`,
  );
  if (input.relation) {
    // An explicit relation is authoritative: replace any previous value so a
    // pair can never carry two relations at once.
    setEdgeRelation(store, edgeIri, relation);
  } else {
    // Callers that only report an outcome must not clobber the relation that
    // the graph already recorded for this transition.
    store.update(
      `PREFIX pg: <${PG}>
INSERT { <${edgeIri}> <${P_RELATION}> <${P_PRECEDES}> }
WHERE { FILTER NOT EXISTS { <${edgeIri}> <${P_RELATION}> ?existing } }`,
    );
  }
  if (input.condition) patchEdgeAttr(store, edgeIri, P_CONDITION, input.condition);
  if (input.guidance) patchEdgeAttr(store, edgeIri, P_GUIDANCE, input.guidance);
  if (input.pitfalls) patchEdgeAttr(store, edgeIri, P_PITFALLS, input.pitfalls);
  if (input.guard !== undefined) setEdgeBoolean(store, edgeIri, P_GUARD, input.guard);
  return edgeIri;
}

/** Set a boolean edge attribute. */
export function setEdgeBoolean(store: ProcedureStore, edgeIri: string, predicate: string, value: boolean): void {
  store.update(`PREFIX pg: <${PG}> DELETE { <${edgeIri}> <${predicate}> ?old } INSERT { <${edgeIri}> <${predicate}> ${value} } WHERE { OPTIONAL { <${edgeIri}> <${predicate}> ?old } }`);
}

/** Overwrite a single textual edge attribute (paper: attribute revision). */
export function patchEdgeAttr(
  store: ProcedureStore,
  edgeIri: string,
  predicate: string,
  value: string,
): void {
  store.update(
    `PREFIX pg: <${PG}>
DELETE { <${edgeIri}> <${predicate}> ?old }
INSERT { <${edgeIri}> <${predicate}> ${JSON.stringify(value)} }
WHERE { OPTIONAL { <${edgeIri}> <${predicate}> ?old } }`,
  );
}

/**
 * Set the relation as an IRI (single-valued).
 *
 * patchEdgeAttr writes a string literal, which is right for textual attributes
 * but wrong for the relation: a literal relation is invisible to IRI-based
 * filters such as `pg:relation pg:precedes`, so those edges vanish from
 * pathfinding while still looking present in the graph.
 */
export function setEdgeRelation(
  store: ProcedureStore,
  edgeIri: string,
  relationIri: string,
): void {
  const full = relationIri.startsWith("http") ? relationIri : PG + relationIri;
  store.update(
    `PREFIX pg: <${PG}>
DELETE { <${edgeIri}> <${P_RELATION}> ?old }
INSERT { <${edgeIri}> <${P_RELATION}> <${full}> }
WHERE { OPTIONAL { <${edgeIri}> <${P_RELATION}> ?old } }`,
  );
}

/**
 * Record one executed transition (from -> to) with its outcome.
 * Updates edge stats incrementally and appends a Run node as provenance.
 */
export function recordOutcome(
  store: ProcedureStore,
  input: OutcomeInput,
): { edgeIri: string; runIri: string } {
  const fromIri = resolveIri(input.from, PG);
  const toIri = resolveIri(input.to, PG);
  const edgeIri = ensureEdge(store, { from: fromIri, to: toIri });
  const isSuccess = input.outcome === "success" ? 1 : 0;
  const isFailure = isSuccess === 1 ? 0 : 1;
  const duration = input.durationSec && input.durationSec > 0 ? input.durationSec : 0;
  const runIri = newRunIri();

  store.update(
    `PREFIX pg: <${PG}>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DELETE {
  <${edgeIri}> <${P_SUCCESS_COUNT}> ?sc ;
                <${P_FAIL_COUNT}> ?fc ;
                <${P_AVG_DURATION_SEC}> ?dur .
}
INSERT {
  <${edgeIri}> <${P_SUCCESS_COUNT}> ?nsc ;
               <${P_FAIL_COUNT}> ?nfc ;
               <${P_AVG_DURATION_SEC}> ?ndur ;
               <${P_UPDATED_AT}> ${JSON.stringify(nowIso())} .
  <${runIri}> a <${C_RUN}> ;
    <${P_RUN_OF}> <${edgeIri}> ;
    <${P_OUTCOME}> ${JSON.stringify(input.outcome)} ;
    <${P_TIMESTAMP}> ${JSON.stringify(nowIso())} ;
    <${P_ACTOR}> ${JSON.stringify(input.actor ?? "unknown")} .
  ${input.notes ? `<${runIri}> <${P_NOTES}> ${JSON.stringify(input.notes)} .` : ""}
  ${duration > 0 ? `<${runIri}> <${P_DURATION_SEC}> ${duration} .` : ""}
  ${input.evidenceKey ? `<${runIri}> <${P_EVIDENCE_KEY}> ${JSON.stringify(input.evidenceKey)} .` : ""}
}
WHERE {
  OPTIONAL { <${edgeIri}> <${P_SUCCESS_COUNT}> ?sc }
  OPTIONAL { <${edgeIri}> <${P_FAIL_COUNT}> ?fc }
  OPTIONAL { <${edgeIri}> <${P_AVG_DURATION_SEC}> ?dur }
  BIND(COALESCE(?sc, 0) + ${isSuccess} AS ?nsc)
  BIND(COALESCE(?fc, 0) + ${isFailure} AS ?nfc)
  BIND(IF(COALESCE(?dur, 0) > 0,
          (COALESCE(?dur, 0) * (COALESCE(?sc, 0) + COALESCE(?fc, 0)) + ${duration}) /
            (COALESCE(?sc, 0) + COALESCE(?fc, 0) + ${duration > 0 ? 1 : 0}),
          ${duration}) AS ?ndur)
}`,
  );
  return { edgeIri, runIri };
}

/** Refiner operation: retire an edge (topology edit, kept for history). */
export function retireEdge(store: ProcedureStore, edgeIri: string): void {
  store.update(
    `PREFIX pg: <${PG}>
DELETE { <${edgeIri}> <${P_STATUS}> ?old }
INSERT { <${edgeIri}> <${P_STATUS}> ${JSON.stringify(STATUS_RETIRED)} }
WHERE { OPTIONAL { <${edgeIri}> <${P_STATUS}> ?old } }`,
  );
}

/** Refiner operation: re-activate a retired edge. */
export function activateEdge(store: ProcedureStore, edgeIri: string): void {
  store.update(
    `PREFIX pg: <${PG}>
DELETE { <${edgeIri}> <${P_STATUS}> ?old }
INSERT { <${edgeIri}> <${P_STATUS}> ${JSON.stringify(STATUS_ACTIVE)} }
WHERE { OPTIONAL { <${edgeIri}> <${P_STATUS}> ?old } }`,
  );
}

export { localPart };

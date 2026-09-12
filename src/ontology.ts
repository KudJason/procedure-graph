/**
 * Ontology constants for the procedural graph.
 * Based on "Procedural Graphs: Self-Evolving Execution Structures for LLM Agents"
 * (arXiv 2609.09153): procedural knowledge is stored as
 * (procedure, relation, procedure) triplets instead of (entity, relation, entity).
 */

export const PG = "https://procedure-graph.dev/ontology#";
export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
export const XSD = "http://www.w3.org/2001/XMLSchema#";

/** Classes */
export const C_PROCEDURE = PG + "Procedure";
export const C_RUN = PG + "Run";
export const C_EDGE = PG + "Edge";
export const C_ROLLOUT = PG + "Rollout";
export const C_PROPOSAL = PG + "Proposal";

/** The Start marker: first decision step is localized here (paper Eq. 2). */
export const START_IRI = PG + "Start";

/** Node kind: tool | skill | reasoning | status (paper Sec. 3.1) */
export const P_KIND = PG + "kind";

/**
 * Edge attribute schema (paper Sec. 3.1): three textual fields per edge.
 *  condition - when the transition applies
 *  guidance  - how to proceed
 *  pitfalls  - what to avoid
 */
export const P_GUIDANCE = PG + "guidance";
export const P_PITFALLS = PG + "pitfalls";

/** Rollout (diagnostic evidence, paper Step 1) */
export const P_TASK = PG + "task";
export const P_TRAJECTORY = PG + "trajectory"; // "a>b>c" local names
export const P_SCORE = PG + "score";
export const P_SPLIT = PG + "split"; // train | val

/** Proposal / candidate edit set (paper Steps 2-4) */
export const P_EDIT = PG + "edit"; // JSON-serialized edit ops
export const P_PROPOSAL_STATUS = PG + "proposalStatus"; // pending|committed|rejected
export const P_VALIDATION_BEFORE = PG + "validationBefore";
export const P_VALIDATION_AFTER = PG + "validationAfter";
export const P_REJECTION_REASON = PG + "rejectionReason";
export const P_EDIT_SUMMARY = PG + "editSummary";

/** Idempotency key so re-importing the same historical record is a no-op. */
export const P_EVIDENCE_KEY = PG + "evidenceKey";

/** Edge endpoints (edges are first-class resources so they can carry stats) */
export const P_FROM = PG + "from";
export const P_TO = PG + "to";
export const P_RELATION = PG + "relation";

/** Procedure-to-procedure relations (the graph topology) */
export const P_PRECEDES = PG + "precedes";
export const P_REQUIRES = PG + "requires";
export const P_ALTERNATIVE_OF = PG + "alternativeOf";
export const P_SUBSTEP_OF = PG + "substepOf";
export const P_REPAIRS = PG + "repairs";

/** Procedure attributes */
export const P_NAME = RDFS + "label";
export const P_DESCRIPTION = RDFS + "comment";
export const P_COMMAND = PG + "command";
export const P_DOC_REF = PG + "docRef";
export const P_ENV = PG + "env"; // dev | staging | prod | any
export const P_CONDITION = PG + "condition"; // when the edge applies
export const P_SUCCESS_COUNT = PG + "successCount";
export const P_FAIL_COUNT = PG + "failCount";
export const P_AVG_DURATION_SEC = PG + "avgDurationSec";
export const P_STATUS = PG + "status"; // active | retired
export const P_UPDATED_AT = PG + "updatedAt";
export const P_RISK = PG + "risk"; // free-text known pitfalls
export const P_GUARD = PG + "guard"; // conditional safety/fallback edge

/** Run provenance (self-evolution input) */
export const P_RUN_OF = PG + "runOf"; // run -> procedure
export const P_OUTCOME = PG + "outcome"; // success | failure
export const P_DURATION_SEC = PG + "durationSec";
export const P_TIMESTAMP = PG + "timestamp";
export const P_NOTES = PG + "notes";
export const P_ACTOR = PG + "actor"; // agent id or human

export const STATUS_ACTIVE = "active";
export const STATUS_RETIRED = "retired";

export const TURTLE_PREFIXES = `@prefix pg: <${PG}> .
@prefix rdfs: <${RDFS}> .
@prefix xsd: <${XSD}> .
@prefix rdf: <${RDF}> .
`;

export function iri(local: string): string {
  return PG + local;
}

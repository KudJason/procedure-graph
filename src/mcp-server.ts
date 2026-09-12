#!/usr/bin/env node
/**
 * MCP stdio server for the procedural graph.
 * Agents call pg_guidance before a workflow and the pg_record_* / pg_propose_*
 * tools afterwards, which is what drives the self-evolution loop.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProcedureStore, GRAPH_FILE, SEED_FILE } from "./store.js";
import { registerTools } from "./tools.js";

const store = new ProcedureStore(process.env.PG_DATA_FILE ?? GRAPH_FILE, SEED_FILE);
const server = new McpServer({ name: "procedure-graph", version: "0.1.0" });

registerTools(server, store);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[procedure-graph] ready: ${store.size()} quads (graph: ${store.graphFile})`,
);

# Procedure Graph MCP

A standalone, self-evolving procedural knowledge graph for AI coding agents.
It stores `(procedure, relation, procedure)` RDF triples in [oxigraph](https://github.com/oxigraph/oxigraph), exposes guidance and learning operations over MCP, and includes a CLI for humans and automation.

## Features

- Localize the current action by procedure name, label, or command.
- Return h-hop neighborhood guidance and ranked next steps.
- Find a fastest successful path using observed duration and success rates.
- Record transition outcomes and complete task rollouts.
- Propose graph mutations and accept/reject them with a held-out validation gate.
- Keep rejected proposals as negative memory for future refinement.
- Import replayable JSON evidence bundles idempotently.

## Requirements

- Node.js 20+
- Yarn 1 or Corepack Yarn
- An MCP client that supports stdio servers (Claude Code, Codex, Cursor, etc.)

## Install and initialize

```bash
git clone https://github.com/KudJason/procedure-graph.git
cd procedure-graph
yarn install
yarn cli reset
yarn test
```

`data/seed-procedures.ttl` is the generic starter graph. Customize it for your project, then run `yarn cli reset`. The generated `data/graph.nq` is the evolving working state; do not hand-edit it.

## MCP configuration

Register the server using an absolute path (recommended so the client can start it from any working directory):

```json
{
  "mcpServers": {
    "procedure-graph": {
      "command": "/absolute/path/to/procedure-graph/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/procedure-graph/src/mcp-server.ts"],
      "env": {
        "PG_DATA_FILE": "/absolute/path/to/procedure-graph/data/graph.nq"
      }
    }
  }
}
```

For a project-local `.mcp.json`, relative paths also work when the client resolves them from that project root:

```json
{
  "mcpServers": {
    "procedure-graph": {
      "command": "procedure-graph/node_modules/.bin/tsx",
      "args": ["procedure-graph/src/mcp-server.ts"]
    }
  }
}
```

The server communicates only through stdout JSON-RPC. Startup diagnostics go to stderr. `PG_DATA_FILE` can point to a separate graph per project, allowing one installation to serve multiple repositories.

## CLI

```bash
yarn cli guidance --last "git push" --goal run-checks
yarn cli path define-scope publish-change
yarn cli outcome --from run-checks --to review-change --outcome success --duration 12
yarn cli rollout --task release --steps define-scope,implement-change,update-tests,run-checks --score 1 --split val
yarn cli import --file evidence/example.json
yarn cli refine
yarn cli propose --file edits.json
yarn cli validate pg:proposal-<id>
yarn cli stats
yarn cli reset
```

Run `yarn cli` for the complete command list.

## Evidence format

Evidence bundles are JSON objects (or arrays of objects):

```json
{
  "source": "ci/run-123",
  "procedures": [
    { "localName": "deploy", "name": "Deploy", "command": "./deploy.sh" }
  ],
  "edges": [
    {
      "from": "run-checks",
      "to": "deploy",
      "relation": "precedes",
      "guidance": "Deploy only after checks pass"
    }
  ],
  "outcomes": [
    { "from": "run-checks", "to": "deploy", "outcome": "success", "durationSec": 30 }
  ],
  "rollouts": [
    { "task": "release", "steps": ["run-checks", "deploy"], "score": 1, "split": "train" }
  ]
}
```

Use `train` for historical evidence that teaches the refiner. Reserve `val` for deliberately held-out evidence used by the validation gate. Imports are idempotent when `source` and record contents are unchanged.

## Graph conventions

- `A precedes B` means A executes before B.
- `A requires B` means B must be completed before A. The pathfinder expands prerequisites and labels them.
- Edges with `guard: true` are conditional fallback/safety edges. They remain visible in guidance and audit output but are excluded from default pathfinding; callers must explicitly opt in when the condition is satisfied.
- Only one relation is stored per `(from, to)` pair.
- Record failures honestly; ranking uses Laplace-smoothed success ratios.
- Never fabricate validation evidence.

## Development

```bash
yarn test
yarn typecheck:core
NODE_OPTIONS=--max-old-space-size=8192 yarn build
```

The full TypeScript build may need extra heap because of MCP SDK and oxigraph type definitions. The core typecheck is a faster iteration check.

## Updating and migrating

```bash
git pull --ff-only
yarn install
yarn cli reset                 # only when intentionally rebuilding from seed
yarn cli import --file evidence  # replay your project evidence if applicable
yarn test
```

Keep project-specific seed and evidence in your deployment repository if you want the upstream repo to stay generic. Use `PG_DATA_FILE` to isolate runtime state, and back up `data/graph.nq` before upgrades.

## License

MIT. See [LICENSE](LICENSE).

# Contributing

1. Create a focused branch.
2. Keep the core engine project-agnostic; put project-specific workflows in the consuming repository.
3. Add or update tests for behavior changes.
4. Run `yarn test` and `yarn typecheck:core` before opening a pull request.
5. Never include credentials, personal data, private logs, or runtime `data/graph.nq` files.

Use conventional, descriptive commit messages and explain migration or compatibility impacts in the pull request.

# @vaultgentic/mcp-server

## 0.2.0

### Minor Changes

- a5794bb: Add `pruneEmptyParents` support to `vaultgentic_remove`, pruning empty source parent directories by default while reporting the removed directories and allowing callers to opt out.

### Patch Changes

- Updated dependencies [a5794bb]
  - @vaultgentic/core@0.2.0

## 0.1.0

### Minor Changes

- b1839eb: Change `vaultgentic_patch` from unified diff input to Vaultgentic agent patch text with `*** Begin Patch` / `*** Update File` syntax. The new format keeps the existing single-note safety model while making patch edits easier for agents to generate reliably.

### Patch Changes

- Updated dependencies [b1839eb]
  - @vaultgentic/core@0.1.0

## 0.0.7

### Patch Changes

- 57bae01: Improve vaultgentic_patch unified diff support for GNU unified diffs and git-style patch wrappers while preserving single-note safety diagnostics.
- Updated dependencies [57bae01]
  - @vaultgentic/core@0.0.6

## 0.0.6

### Patch Changes

- 49f4491: Use patch-compatible workspace ranges so Changesets does not release unchanged dependents for internal patch bumps.

## 0.0.5

### Patch Changes

- c9043b4: Fix path filter missing from search diagnostics; add scope/path mutual exclusion; move tool parameter detail into schema descriptions
- Updated dependencies [c9043b4]
  - @vaultgentic/core@0.0.5

## 0.0.4

### Patch Changes

- 3e8fe1d: Fix patch diff application issues around blank lines
- Updated dependencies [3e8fe1d]
  - @vaultgentic/core@0.0.4

## 0.0.3

### Patch Changes

- Release recent vault mutation, indexing, and MCP tool updates.
- Updated dependencies
  - @vaultgentic/core@0.0.3

## 0.0.2

### Patch Changes

- Publish the core exports required by the MCP server package.
- Updated dependencies
  - @vaultgentic/core@0.0.2

## 0.0.1

### Patch Changes

- Publish the first MCP server package for GitHub Packages consumers.

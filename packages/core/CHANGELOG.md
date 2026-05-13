# @vaultgentic/core

## 0.1.0

### Minor Changes

- b1839eb: Change `vaultgentic_patch` from unified diff input to Vaultgentic agent patch text with `*** Begin Patch` / `*** Update File` syntax. The new format keeps the existing single-note safety model while making patch edits easier for agents to generate reliably.

## 0.0.6

### Patch Changes

- 57bae01: Improve vaultgentic_patch unified diff support for GNU unified diffs and git-style patch wrappers while preserving single-note safety diagnostics.

## 0.0.5

### Patch Changes

- c9043b4: Fix path filter missing from search diagnostics; add scope/path mutual exclusion; move tool parameter detail into schema descriptions

## 0.0.4

### Patch Changes

- 3e8fe1d: Fix patch diff application issues around blank lines

## 0.0.3

### Patch Changes

- Release recent vault mutation, indexing, and MCP tool updates.

## 0.0.2

### Patch Changes

- Publish the core exports required by the MCP server package.

## 0.0.1

### Patch Changes

- 84e3811: Prepare core and CLI packages for GitHub Packages publishing.

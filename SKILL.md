---
name: using-vaultgentic
description: Proactively retrieves and persists agent-useful markdown vault notes with vaultgentic tools. Use when the user asks to remember, record, save, retrieve, or search prior information; when key preferences, facts, research findings, or decisions could be useful in the future; or when vault context may improve the current task.
tags: [vaultgentic, vault, skill]
---

# Using Vaultgentic

Vaultgentic exposes a markdown vault via MCP tools. Use them proactively — search before answering when prior context may exist, and capture durable preferences, decisions, and findings without waiting to be asked. Prefer updating existing notes over creating duplicates, and keep notes concise and future-oriented.

## Tools

- `vaultgentic:vaultgentic_search` — search indexed notes by query, mode, scope, or tags
- `vaultgentic:vaultgentic_read` — read a note by vault-relative path or a chunk by ID
- `vaultgentic:vaultgentic_write` — create or replace a `.md` note. `body`, `frontmatter`, `tags`, and `aliases` are separate parameters — pass structured frontmatter, do not embed YAML in `body`
- `vaultgentic:vaultgentic_patch` — apply a Vaultgentic agent patch to one existing note. Use `*** Begin Patch`, exactly one `*** Update File: <path>` matching the tool `path`, `@@` chunks with context lines prefixed by space, removals with `-`, additions with `+`, and `*** End Patch`. Add, delete, move, path mismatch, and multi-operation patches are unsupported. Read first, then pass `expectedFileHash` from the read for concurrency safety; on hash mismatch or failed matching, re-read and regenerate the patch
- `vaultgentic:vaultgentic_remove` — remove a note. Pass `expectedFileHash`; surface the response's `operation` (archived/deleted) and any `archivedPath`

## When to act

- **Search/read** before writing, when retrieving prior context, or when a named note may exist
- **Write** for new notes or full rewrites of durable content
- **Patch** for targeted changes to part of an existing note
- **Remove** when the user asks to delete a note, a note is superseded, or a duplicate should go

Do not store secrets, ephemeral state, raw transcripts, chain-of-thought, or facts already captured in code, tests, git history, or an issue tracker.

## Scopes

`vaultgentic_search` accepts an optional `scope` string restricting results to a folder prefix. The vault's layout is the user's — discover it by searching and reading, not by assuming a fixed structure.

## Search modes

- `hybrid` — default
- `keyword` — exact terms, code symbols, proper nouns
- `semantic` — conceptual queries where wording may differ
- `title` — direct lookup by note name or alias

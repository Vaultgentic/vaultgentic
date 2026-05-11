---
name: using-vaultgentic
description: Proactively retrieves and persists agent-useful markdown vault notes with vaultgentic tools. Use when the user asks to remember, record, save, retrieve, or search prior information; when key preferences, facts, research findings, or decisions could be useful in the future; or when vault context may improve the current task.
tags: [vaultgentic, vault, skill]
---

# Using Vaultgentic

Vaultgentic provides search, read, and write access to a markdown vault (typically an Obsidian vault or plain markdown folder).

## Operating stance

Use the vault proactively for durable, retrievable knowledge that could help future work. Search before writing, prefer updating existing notes over creating duplicates, and keep notes concise, sourced, and future-oriented.

## Tools

- `vaultgentic:vaultgentic_search` — search indexed notes by query, mode, scope, or tags
- `vaultgentic:vaultgentic_read` — read a note by vault-relative path or a chunk by ID
- `vaultgentic:vaultgentic_write` — create or update a note at a vault-relative `.md` path

## When to act

**Search first** before writing — check whether a relevant note exists to update rather than duplicate. Also search when the user asks about something that may have been previously recorded.

**Search/read when:**
- The user asks to retrieve, recall, look up, or search prior information
- Current work may depend on preferences, decisions, research, or other reusable context
- You need to check whether a note already exists before writing

**Write when:**
- The user explicitly asks to remember, record, or save something
- The user states a preference, recurring fact, constraint, or personal/project context likely to matter later
- Research produces durable findings likely to be useful in future work
- A significant decision or approval should be available later and is not obvious from code, tests, git history, or an issue tracker
- A durable deliverable has been produced and the user may need to retrieve it later

**Do not write:**
- Secrets, credentials, tokens, private keys, or sensitive personal data unless explicitly requested
- Ephemeral in-session state
- Facts already in code, tests, or git history
- Facts already captured clearly in an issue tracker
- Intermediate reasoning the user will never retrieve
- Raw transcripts or chain-of-thought

## Workflows

### Retrieve

1. Choose the narrowest likely scope.
2. Search with `hybrid` by default.
3. Use `keyword` for exact names, code symbols, and proper nouns.
4. Use `title` for direct note-name or alias lookups.
5. Read promising results before relying on them.
6. If nothing relevant is found, say so plainly.

### Write or update

1. Confirm the information is durable enough to be useful in the future.
2. Search the narrowest likely scope first.
3. Read the best matching note if one exists.
4. Update that note unless a new note is clearly warranted.
5. Preserve existing useful content and merge new information concisely.
6. Include frontmatter with `title`, `description`, and `tags`.
7. Store summaries and decisions, not raw conversation dumps.

## Folder structure

All agent notes live under `agent/` in the vault. Prefer subfolders when content is project-scoped or when grouping related notes makes sense (e.g. `agent/research/auth-system/`, `agent/projects/vaultgentic/`).

| Folder | Purpose |
|---|---|
| `agent/inbox/` | No clear home — refile later |
| `agent/preferences/` | User preferences, stated style choices, agent behaviour |
| `agent/memory/` | Recurring facts and context not tied to a specific project |
| `agent/research/` | Investigation findings and summarised research |
| `agent/tasks/` | Completed work records, decisions, approvals |
| `agent/drafts/` | Specs, design docs, user-facing documents |
| `agent/projects/<name>/` | Notes scoped to a named project |

When content is clearly tied to a named project, `agent/projects/<name>/` takes precedence.

## Scopes

Pass a `scope` string to `vaultgentic:vaultgentic_search` to restrict results to a folder prefix. Use the narrowest scope that covers the likely location. Omit scope when the query spans multiple areas.

| Scope | Covers |
|---|---|
| `agent/inbox` | Unclassified notes |
| `agent/preferences` | Preferences and behaviour settings |
| `agent/memory` | Recurring facts |
| `agent/research` | All research (or `agent/research/<topic>`) |
| `agent/tasks` | Work logs and decisions |
| `agent/drafts` | Deliverables |
| `agent/projects` | All project notes (or `agent/projects/<name>`) |

## Search modes

- `hybrid` — default; use for most queries
- `keyword` — exact terms, code symbols, proper nouns
- `semantic` — conceptual queries where wording may differ
- `title` — direct lookup by note name or alias

## Frontmatter

Always include `title`, `description`, and `tags` when writing a note:

```yaml
---
title: Note Title
description: One-line summary of the note's content.
tags: [topic, category]
---
```

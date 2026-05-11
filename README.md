# Vaultgentic

Vaultgentic gives local agents and terminals a searchable view of an Obsidian-style Markdown vault. It builds a SQLite index for your notes and supports keyword, title, semantic, and hybrid search modes.

## Packages

| Package | Use it when | Documentation |
|---|---|---|
| `@vaultgentic/cli` | You want terminal commands for indexing, searching, and reading notes. | [CLI guide](apps/cli/README.md) |
| `@vaultgentic/mcp-server` | You want MCP-compatible agents to search, read, and write vault notes. | [MCP server guide](apps/mcp-server/README.md) |
| `@vaultgentic/core` | You are building another app or integration on top of Vaultgentic. | API types are exported from the package. |

## What it does

- Indexes Markdown notes into a local SQLite database.
- Searches by full-text keywords, note titles and aliases, semantic meaning, or hybrid ranking.
- Reads notes and indexed chunks with optional metadata.
- Lets MCP agents create or update Obsidian-compatible Markdown notes.
- Keeps all vault content local.

Semantic and hybrid search use the `Xenova/all-MiniLM-L6-v2` embedding model. The first index or semantic search may download and load model files; later runs reuse the local cache.

## Requirements

- Node.js 24 or newer.
- A folder of Markdown notes, such as an Obsidian vault.

## Basic configuration

Vaultgentic reads JSON configuration from `VAULTGENTIC_CONFIG`, from `--config <path>` in the CLI, or from the default config path for your platform.

Example config:

```json
{
  "vaultPath": "/absolute/path/to/ObsidianVault",
  "databasePath": "/absolute/path/to/ObsidianVault/.vaultgentic/index.sqlite",
  "searchLimit": 5,
  "ignoredPaths": ["Templates", "Archive/private", "**/node_modules/**"]
}
```

Fields:

- `vaultPath`: required path to your Markdown vault.
- `databasePath`: required path for the SQLite index.
- `searchLimit`: optional default result count. Defaults to `5`.
- `ignoredPaths`: optional vault-relative paths or glob patterns to skip. Vaultgentic always ignores `.obsidian`, `.trash`, `node_modules`, `.git`, and `.vaultgentic`.

## Quick start

For terminal usage, install the CLI:

```sh
npm install --global @vaultgentic/cli
vaultgentic index sync --config /path/to/config.json
vaultgentic search "project planning" --config /path/to/config.json
```

For agents, install the MCP server:

```sh
npm install --global @vaultgentic/mcp-server
vaultgentic-mcp-server
```

See the [CLI guide](apps/cli/README.md) and [MCP server guide](apps/mcp-server/README.md) for full setup and troubleshooting.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Release maintenance uses Changesets:

```sh
pnpm changeset
pnpm version-packages
pnpm release:dry-run
```

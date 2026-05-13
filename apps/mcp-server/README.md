# Vaultgentic MCP Server

The Vaultgentic MCP server exposes local vault search, read, and write tools to MCP-compatible agents over stdio.

## Install

Vaultgentic packages are published on GitHub Packages. Configure npm for the `@vaultgentic` scope first:

```sh
npm config set @vaultgentic:registry https://npm.pkg.github.com
```

GitHub Packages requires npm authentication even for public packages. Use a GitHub token with package read access:

```sh
npm login --scope=@vaultgentic --auth-type=legacy --registry=https://npm.pkg.github.com
```

Install the MCP server globally:

```sh
npm install --global @vaultgentic/mcp-server
```

Global install is recommended because the server uses native ML dependencies for semantic search. Installing once avoids repeated `npx` installs and native runtime extraction during MCP client startup.

## Configure Vaultgentic

Use a standard Vaultgentic config file:

```json
{
  "vaultPath": "/absolute/path/to/ObsidianVault",
  "databasePath": "/absolute/path/to/ObsidianVault/.vaultgentic/index.sqlite",
  "searchLimit": 5,
  "archiveOnRemove": true,
  "archiveFolder": "_archives",
  "ignoredPaths": ["Templates", "Archive/private", "**/node_modules/**"]
}
```

`archiveOnRemove` defaults to `true` and `archiveFolder` defaults to `_archives` at the vault root. Vaultgentic ignores `_archives` by default so archived notes are not indexed.

Then point the server at it:

```sh
export VAULTGENTIC_CONFIG=/path/to/config.json
vaultgentic-mcp-server
```

For simple setups, you can use only a vault path:

```sh
export VAULTGENTIC_VAULT_PATH=/absolute/path/to/ObsidianVault
vaultgentic-mcp-server
```

When `VAULTGENTIC_VAULT_PATH` is used without a config file, the server stores its SQLite index at `.vaultgentic/index.sqlite` inside the vault and uses default ignored paths.

## MCP client setup

Recommended command configuration:

```json
{
  "mcp": {
    "vaultgentic": {
      "type": "local",
      "command": ["vaultgentic-mcp-server"],
      "environment": {
        "VAULTGENTIC_CONFIG": "/path/to/config.json"
      },
      "enabled": true
    }
  }
}
```

`npx` is supported for quick trials, but it can be slower because it may install or extract native dependencies while the MCP client is waiting for the server to start:

```json
{
  "command": ["npx", "-y", "@vaultgentic/mcp-server@latest"],
  "environment": {
    "VAULTGENTIC_CONFIG": "/path/to/config.json"
  }
}
```

## First-run model download

Semantic and hybrid search use the `Xenova/all-MiniLM-L6-v2` embedding model. The first index or semantic search may download and load model files, which can take noticeable time. Later runs reuse the local cache.

If an agent appears to pause on its first search or index operation, it is likely waiting for the embedding model or native runtime to finish loading.

## Tools

| Tool | Purpose |
|---|---|
| `vaultgentic_search` | Search indexed vault notes by query, mode, scope, tags, and result limit. |
| `vaultgentic_read` | Read a vault-relative Markdown note path or indexed chunk id. |
| `vaultgentic_write` | Create or update an Obsidian-compatible Markdown note. |
| `vaultgentic_patch` | Patch one existing Markdown note with Vaultgentic agent patch text. |
| `vaultgentic_remove` | Remove a Markdown note, archiving by default. |

Search and read refresh the index before responding. Write creates or updates a note and reindexes that file so later searches can find it.

`vaultgentic_patch` accepts one existing note path and Vaultgentic agent patch text:

```diff
*** Begin Patch
*** Update File: notes/example.md
@@
 Existing context line
-Old line
+New line
*** End Patch
```

Patch text must contain exactly one `*** Update File: <path>` operation that matches the tool `path`, one or more `@@` chunks, context lines prefixed by a space, removed lines prefixed by `-`, added lines prefixed by `+`, and the begin/end markers. `Add File`, `Delete File`, `Move to`, multiple file operations, path mismatches, and creating missing notes are unsupported. Read first and pass `expectedFileHash` when possible so stale edits are rejected safely.

## Troubleshooting

- MCP client shows the server as disabled: prefer the global install command `vaultgentic-mcp-server` instead of `npx`, then restart the client.
- First search or index appears slow: wait for the embedding model download/load to complete. Future runs should be faster.
- `Could not read config`: set `VAULTGENTIC_CONFIG` to a valid config path or set `VAULTGENTIC_VAULT_PATH`.
- `Database vault root mismatch`: use a new `databasePath`, restore the original `vaultPath`, or rebuild the index.
- `Unsupported search mode`: use `hybrid`, `keyword`, `semantic`, or `title`.

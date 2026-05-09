# Vaultgentic

Vaultgentic is a local command-line search tool for Obsidian-style Markdown vaults. It builds a SQLite search index for your notes, then lets you search by keywords, title, meaning, or the default hybrid mode.

## Prerequisites

- Node.js 24 or newer
- pnpm 11, when running from source or doing release maintenance
- A folder of Markdown notes, such as an Obsidian vault

Semantic and hybrid search use the `Xenova/all-MiniLM-L6-v2` embedding model. The first indexing or semantic search run may download model files through `@huggingface/transformers`.

## Install with npm

Vaultgentic packages are published under the `@vaultgentic` scope on GitHub Packages. Configure npm for that scope before installing:

```sh
npm config set @vaultgentic:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "YOUR_GITHUB_TOKEN"
```

For normal terminal use, install the CLI. npm installs `@vaultgentic/core` automatically as a dependency:

```sh
npm install --global @vaultgentic/cli
vaultgentic --help
```

Only install the core package directly when building your own app or tool against Vaultgentic's APIs:

```sh
npm install @vaultgentic/core
```

## Run from source

Run the CLI from a repository checkout:

```sh
cd /path/to/vaultgentic
pnpm install
pnpm --filter @vaultgentic/core --filter @vaultgentic/cli build
node apps/cli/dist/index.js --help
```

The examples below use `vaultgentic` as the command name. From a source checkout, create a shell alias first:

```sh
alias vaultgentic='node /path/to/vaultgentic/apps/cli/dist/index.js'
```

## Configure Vaultgentic

Vaultgentic reads JSON configuration from one of these locations:

1. `--config <path>` on each command
2. the `VAULTGENTIC_CONFIG` environment variable
3. the default config path:
   - macOS/Linux: `$XDG_CONFIG_HOME/vaultgentic/config.json`, or `~/.config/vaultgentic/config.json` when `XDG_CONFIG_HOME` is unset
   - Windows: `%APPDATA%\vaultgentic\config.json`

Create a config file like this:

```json
{
  "vaultPath": "/absolute/path/to/ObsidianVault",
  "databasePath": "/absolute/path/to/ObsidianVault/.vaultgentic/index.sqlite",
  "ignoredPaths": ["Templates", "Archive/private"]
}
```

Fields:

- `vaultPath`: required path to your Markdown vault.
- `databasePath`: required path for Vaultgentic's SQLite index. Keeping it inside `.vaultgentic/` in the vault is convenient and ignored by default.
- `ignoredPaths`: optional vault-relative paths to skip. Vaultgentic always ignores `.obsidian`, `.trash`, `node_modules`, `.git`, and `.vaultgentic`.

Paths inside the vault should be vault-relative and use Markdown file names such as `Projects/Alpha.md`.

## Build and maintain the index

### Check status

```sh
vaultgentic index status --config /path/to/config.json
```

Status initializes the database if needed and prints the vault path, database path, note and chunk counts, SQLite health, vector readiness, and embedding model metadata.

Use JSON output for scripts:

```sh
vaultgentic index status --config /path/to/config.json --json
```

### Sync changed notes

```sh
vaultgentic index sync --config /path/to/config.json
```

Sync scans Markdown files in the vault, indexes changed notes, skips unchanged notes, and removes notes that no longer exist.

### Index one note

```sh
vaultgentic index file Projects/Alpha.md --config /path/to/config.json
```

Use this after editing one note when you do not want to scan the whole vault.

All index subcommands accept `--json` for structured output:

```sh
vaultgentic index sync --config /path/to/config.json --json
```

### Rebuild the index

```sh
vaultgentic index rebuild --config /path/to/config.json
```

Rebuild deletes and recreates index contents. In an interactive terminal, Vaultgentic asks you to type `rebuild` before continuing.

For non-interactive use, pass `--force`:

```sh
vaultgentic index rebuild --config /path/to/config.json --force
```

## Search notes

Run search after indexing or syncing your vault:

```sh
vaultgentic search "project planning" --config /path/to/config.json
```

The default search mode is `hybrid`. It combines:

- `keyword`: BM25 full-text search over note chunks
- `semantic`: vector search over note chunks
- `title`: title and alias search

Choose a mode explicitly with `--mode`:

```sh
vaultgentic search "project planning" --mode hybrid --config /path/to/config.json
vaultgentic search "project planning" --mode keyword --config /path/to/config.json
vaultgentic search "project planning" --mode semantic --config /path/to/config.json
vaultgentic search "project planning" --mode title --config /path/to/config.json
```

Limit result count:

```sh
vaultgentic search "project planning" --limit 5 --config /path/to/config.json
```

Show scores in human-readable output:

```sh
vaultgentic search "project planning" --scores --config /path/to/config.json
```

Print structured JSON:

```sh
vaultgentic search "project planning" --json --config /path/to/config.json
```

Human-readable search results include the rank, title, path, optional heading, optional snippet, and `Matched by` sources. JSON includes the same data plus numeric scores and chunk location fields when available.

## Read notes and chunks

Read a note by vault-relative Markdown path:

```sh
vaultgentic read Projects/Alpha.md --config /path/to/config.json
```

Read an indexed chunk by numeric chunk id:

```sh
vaultgentic read 42 --config /path/to/config.json
```

Limit the returned content size:

```sh
vaultgentic read Projects/Alpha.md --max-chars 2000 --config /path/to/config.json
```

Include indexed note metadata when reading a note:

```sh
vaultgentic read Projects/Alpha.md --with-metadata --config /path/to/config.json
```

Include note context when reading a chunk:

```sh
vaultgentic read 42 --with-note-context --config /path/to/config.json
```

Print structured JSON:

```sh
vaultgentic read Projects/Alpha.md --json --config /path/to/config.json
```

## Common options

- `--config <path>`: read a specific config file.
- `--json`: print structured JSON where supported.
- `--help`: show command-specific usage.

Useful help commands:

```sh
vaultgentic --help
vaultgentic index --help
vaultgentic index file --help
vaultgentic index sync --help
vaultgentic index rebuild --help
vaultgentic index status --help
vaultgentic search --help
vaultgentic read --help
```

## Release packages

Vaultgentic uses Changesets to version and publish packages to GitHub Packages. The release workflow publishes:

- `@vaultgentic/core`
- `@vaultgentic/cli`

`@vaultgentic/mcp-server` remains private until it is ready to publish.

Create a changeset for a user-facing package change:

```sh
pnpm changeset
```

Common release maintenance commands:

```sh
pnpm version-packages
pnpm release:dry-run
```

`pnpm release:dry-run` builds the workspace and runs pnpm's recursive publish dry run to verify package contents and registry configuration without publishing.

On pushes to `main`, `.github/workflows/release.yml` runs the test/build checks, then `changesets/action` either opens or updates a version PR. Merging that version PR publishes changed packages to GitHub Packages.

The workflow uses the repository `GITHUB_TOKEN`; no custom npm token is required when publishing from `Vaultgentic/vaultgentic`. Required workflow permissions are `contents: write`, `pull-requests: write`, and `packages: write`.

For package installation, see [Install with npm](#install-with-npm).

## Troubleshooting

### `Could not read config`

Vaultgentic could not find or open the config file. Pass `--config /path/to/config.json`, set `VAULTGENTIC_CONFIG`, or create the default config file.

### `Invalid config JSON` or `Invalid config`

The config file is not valid JSON or is missing required string fields. Check that `vaultPath` and `databasePath` are present and non-empty.

### `Path must stay inside the vault`

The note path resolved outside `vaultPath`. Use a vault-relative path such as `Folder/Note.md`; do not use `..` to leave the vault.

### `Read target must be a numeric chunk id or vault-relative .md note path`

`vaultgentic read` only accepts a chunk id like `42` or a Markdown note path ending in `.md`.

### `Search limit must be a positive integer` or `Max chars must be a positive integer`

Use whole numbers greater than zero for `--limit` and `--max-chars`.

### `Unsupported search mode`

Use one of: `hybrid`, `keyword`, `semantic`, or `title`.

### `Index rebuild confirmation requires an interactive terminal`

`vaultgentic index rebuild` needs an interactive prompt unless you pass `--force`.

### `Database vault root mismatch`

The configured database was created for a different vault path. Update `databasePath` to a new index file, restore the original `vaultPath`, or rebuild with the intended vault/database pairing.

### Semantic or hybrid search returns no vector results

Run `vaultgentic index status --config /path/to/config.json` and check that `sqlite-vec available` and `Vector storage ready` are `yes`. Then rebuild or sync the index so chunks have embeddings.

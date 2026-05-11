# Vaultgentic CLI

The Vaultgentic CLI indexes, searches, and reads an Obsidian-style Markdown vault from your terminal.

## Install

Vaultgentic packages are published on GitHub Packages. Configure npm for the `@vaultgentic` scope first:

```sh
npm config set @vaultgentic:registry https://npm.pkg.github.com
```

GitHub Packages requires npm authentication even for public packages. Use a GitHub token with package read access:

```sh
npm login --scope=@vaultgentic --auth-type=legacy --registry=https://npm.pkg.github.com
```

Install the CLI globally:

```sh
npm install --global @vaultgentic/cli
```

Check the install:

```sh
vaultgentic --help
```

## Configure

Create a config file:

```json
{
  "vaultPath": "/absolute/path/to/ObsidianVault",
  "databasePath": "/absolute/path/to/ObsidianVault/.vaultgentic/index.sqlite",
  "searchLimit": 5,
  "ignoredPaths": ["Templates", "Archive/private", "**/node_modules/**"]
}
```

Pass it with `--config`:

```sh
vaultgentic index status --config /path/to/config.json
```

Or set it once in your shell:

```sh
export VAULTGENTIC_CONFIG=/path/to/config.json
vaultgentic index status
```

## Index notes

Check index status:

```sh
vaultgentic index status --config /path/to/config.json
```

Index changed notes and remove deleted notes:

```sh
vaultgentic index sync --config /path/to/config.json
```

Index one note by vault-relative path:

```sh
vaultgentic index file Projects/Alpha.md --config /path/to/config.json
```

Rebuild the index from scratch:

```sh
vaultgentic index rebuild --config /path/to/config.json
```

For non-interactive rebuilds:

```sh
vaultgentic index rebuild --config /path/to/config.json --force
```

All index commands support `--json` for structured output.

## Search notes

Search with the default hybrid mode:

```sh
vaultgentic search "project planning" --config /path/to/config.json
```

Choose a mode:

```sh
vaultgentic search "project planning" --mode hybrid --config /path/to/config.json
vaultgentic search "project planning" --mode keyword --config /path/to/config.json
vaultgentic search "project planning" --mode semantic --config /path/to/config.json
vaultgentic search "project planning" --mode title --config /path/to/config.json
```

Limit results:

```sh
vaultgentic search "project planning" --limit 5 --config /path/to/config.json
```

Show scores or JSON output:

```sh
vaultgentic search "project planning" --scores --config /path/to/config.json
vaultgentic search "project planning" --json --config /path/to/config.json
```

Semantic and hybrid search use the `Xenova/all-MiniLM-L6-v2` embedding model. The first index or semantic search may download and load model files; later runs reuse the local cache.

## Read notes and chunks

Read a note:

```sh
vaultgentic read Projects/Alpha.md --config /path/to/config.json
```

Read an indexed chunk:

```sh
vaultgentic read 42 --config /path/to/config.json
```

Limit content or include metadata:

```sh
vaultgentic read Projects/Alpha.md --max-chars 2000 --config /path/to/config.json
vaultgentic read Projects/Alpha.md --with-metadata --config /path/to/config.json
vaultgentic read 42 --with-note-context --config /path/to/config.json
```

Print JSON:

```sh
vaultgentic read Projects/Alpha.md --json --config /path/to/config.json
```

## Run from source

```sh
pnpm install
pnpm --filter @vaultgentic/core --filter @vaultgentic/cli build
node apps/cli/dist/index.js --help
```

## Troubleshooting

- `Could not read config`: pass `--config /path/to/config.json`, set `VAULTGENTIC_CONFIG`, or create the default config file.
- `Invalid config`: check that `vaultPath` and `databasePath` are present and valid strings.
- `Path must stay inside the vault`: use a vault-relative Markdown path such as `Projects/Alpha.md`.
- `Unsupported search mode`: use `hybrid`, `keyword`, `semantic`, or `title`.
- `Index rebuild confirmation requires an interactive terminal`: pass `--force` for non-interactive rebuilds.
- `Database vault root mismatch`: use a new `databasePath`, restore the original `vaultPath`, or rebuild the index.

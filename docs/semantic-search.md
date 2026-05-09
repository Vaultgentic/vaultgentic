# Semantic search manual check

Run a real-vault semantic query after syncing the index:

```sh
vaultgentic index sync --config /path/to/config.json
vaultgentic search "finding notes by meaning" --mode semantic --config /path/to/config.json --scores
```

Expected: results include path, title, heading, snippet, `Matched by: vector`, and vector distance score.

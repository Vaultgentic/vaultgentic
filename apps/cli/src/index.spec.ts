import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSearchDatabase } from "@vaultgentic/core";
import { createProgram, packageVersion } from "./index.js";

describe("GIVEN the CLI package", () => {
  describe("WHEN creating the Commander program", () => {
    describe("THEN command metadata is configured", () => {
      it("SHOULD use the vaultgentic command name", () => {
        expect(createProgram().name()).toBe("vaultgentic");
      });

      it("SHOULD report the package version", () => {
        expect(createProgram().version()).toBe(packageVersion);
      });

      it("SHOULD include the index status command", () => {
        const indexCommand = createProgram().commands.find(
          (command) => command.name() === "index",
        );

        expect(indexCommand?.commands.map((command) => command.name())).toEqual(
          expect.arrayContaining(["file", "sync", "rebuild", "status"]),
        );
      });

      it("SHOULD include the search command", () => {
        expect(
          createProgram().commands.map((command) => command.name()),
        ).toEqual(expect.arrayContaining(["search"]));
      });

      it("SHOULD include the read command", () => {
        expect(
          createProgram().commands.map((command) => command.name()),
        ).toEqual(expect.arrayContaining(["read"]));
      });
    });
  });
});

describe("GIVEN the index file command", () => {
  describe("WHEN JSON output is requested", () => {
    describe("THEN the requested note is indexed", () => {
      it("SHOULD print the file indexing result", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-cli-file-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          path.join(vaultPath, "alpha.md"),
          "# Alpha\n\nCLI keyword",
        );
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const output: string[] = [];
        const previousLog = console.log;
        console.log = (message?: unknown) => {
          output.push(String(message));
        };

        try {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "file",
              "alpha.md",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        } finally {
          console.log = previousLog;
        }

        expect(JSON.parse(output.join("\n"))).toMatchObject({
          path: "alpha.md",
          status: "indexed",
          chunkCount: 1,
        });
      });
    });
  });
});

describe("GIVEN the index sync command", () => {
  describe("WHEN JSON output is requested", () => {
    describe("THEN changed vault notes are indexed", () => {
      it("SHOULD print sync counts", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-cli-sync-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          path.join(vaultPath, "alpha.md"),
          "# Alpha\n\nSync keyword",
        );
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const output: string[] = [];
        const previousLog = console.log;
        console.log = (message?: unknown) => {
          output.push(String(message));
        };

        try {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        } finally {
          console.log = previousLog;
        }

        expect(JSON.parse(output.join("\n"))).toMatchObject({
          indexed: 1,
          skipped: 0,
          deleted: 0,
        });
      });
    });
  });
});

describe("GIVEN the index status command", () => {
  describe("WHEN JSON output is requested", () => {
    describe("THEN the configured database is initialized and reported", () => {
      it("SHOULD print database status", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-cli-status-"),
        );
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const output: string[] = [];
        const previousLog = console.log;
        console.log = (message?: unknown) => {
          output.push(String(message));
        };

        try {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "status",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        } finally {
          console.log = previousLog;
        }

        expect(JSON.parse(output.join("\n"))).toMatchObject({
          vaultPath,
          databasePath,
          schemaVersion: 1,
          noteCount: 0,
          chunkCount: 0,
          sqlite: {
            ok: true,
            walEnabled: true,
            foreignKeysEnabled: true,
          },
        });
      });
    });
  });
});

describe("GIVEN the index rebuild command", () => {
  describe("WHEN confirmation is rejected", () => {
    describe("THEN the destructive rebuild is cancelled", () => {
      it("SHOULD NOT rebuild the configured index", async () => {
        const { configPath } = await createSearchFixture("rebuild-cancelled");

        const output = await captureConsoleLog(async () => {
          await createProgram({
            confirmIndexRebuild: async () => false,
          }).parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "rebuild",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toEqual({ cancelled: true });
      });
    });
  });

  describe("WHEN force is requested", () => {
    describe("THEN the prompt is skipped and the index is rebuilt", () => {
      it("SHOULD replace stale data and print updated status", async () => {
        const { configPath, databasePath, vaultPath } =
          await createSearchFixture("rebuild-forced");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });
        await rm(path.join(vaultPath, "beta.md"));
        let promptCalled = false;

        const output = await captureConsoleLog(async () => {
          await createProgram({
            confirmIndexRebuild: async () => {
              promptCalled = true;
              return false;
            },
          }).parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "rebuild",
              "--config",
              configPath,
              "--force",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(promptCalled).toBe(false);
        expect(JSON.parse(output)).toMatchObject({
          indexed: 1,
          skipped: 0,
          deleted: 1,
          status: {
            noteCount: 1,
            chunkCount: 2,
            lastIndexedAt: expect.any(Number),
          },
        });
        expect(readIndexedPaths({ databasePath, vaultPath })).toEqual([
          "alpha.md",
        ]);
      });
    });
  });
});

describe("GIVEN the search command", () => {
  describe("WHEN keyword mode prints human output", () => {
    describe("THEN compact ranked matches are shown", () => {
      it("SHOULD print title, path, heading, snippet, matched-by, and scores", async () => {
        const { configPath } = await createSearchFixture("human");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "sqlite-vec",
              "--mode",
              "keyword",
              "--config",
              configPath,
              "--scores",
            ],
            { from: "node" },
          );
        });

        expect(output).toContain("1. Alpha");
        expect(output).toContain("Path: alpha.md");
        expect(output).toContain("Heading: Alpha > Details");
        expect(output).toContain("sqlite-vec");
        expect(output).toContain("Matched by: keyword");
        expect(output).toContain("Score:");
      });
    });
  });

  describe("WHEN keyword mode prints JSON output", () => {
    describe("THEN technical search result fields are returned", () => {
      it("SHOULD print keyword search results", async () => {
        const { configPath } = await createSearchFixture("json");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "sqlite-vec",
              "--mode",
              "keyword",
              "--config",
              configPath,
              "--limit",
              "1",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject([
          {
            rank: 1,
            title: "Alpha",
            path: "alpha.md",
            headingPath: ["Alpha", "Details"],
            matchedBy: ["keyword"],
            chunkIndex: expect.any(Number),
            score: expect.any(Number),
          },
        ]);
      });
    });
  });

  describe("WHEN title mode prints JSON output", () => {
    describe("THEN known-note matches include title metadata", () => {
      it("SHOULD search titles, aliases, and paths with limit support", async () => {
        const { configPath, vaultPath } =
          await createSearchFixture("title-json");
        await mkdir(path.join(vaultPath, "search"), { recursive: true });
        await writeFile(
          path.join(vaultPath, "search", "embedding-index.md"),
          "---\ntitle: Embedding Index\naliases:\n  - Vector Lookup\n---\n\n# Embedding Index\n\nSemantic notes.",
        );
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "Vector Lookup",
              "--mode",
              "title",
              "--config",
              configPath,
              "--limit",
              "1",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject([
          {
            rank: 1,
            title: "Embedding Index",
            path: "search/embedding-index.md",
            aliases: ["Vector Lookup"],
            matchedBy: ["title"],
            score: expect.any(Number),
          },
        ]);
      });
    });
  });

  describe("WHEN semantic mode prints JSON output", () => {
    describe("THEN vector search result fields are returned", () => {
      it("SHOULD print semantic search results", async () => {
        const { configPath } = await createSearchFixture("semantic-json");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "finding notes by meaning",
              "--mode",
              "semantic",
              "--config",
              configPath,
              "--limit",
              "1",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject([
          {
            rank: 1,
            path: expect.any(String),
            title: expect.any(String),
            headingPath: expect.any(Array),
            snippet: expect.any(String),
            matchedBy: ["vector"],
            chunkIndex: expect.any(Number),
            score: expect.any(Number),
          },
        ]);
      });
    });
  });

  describe("WHEN title mode prints human output", () => {
    describe("THEN compact known-note matches are shown", () => {
      it("SHOULD print matched-by and scores without chunk fields", async () => {
        const { configPath } = await createSearchFixture("title-human");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "Alpha",
              "--mode",
              "title",
              "--config",
              configPath,
              "--scores",
            ],
            { from: "node" },
          );
        });

        expect(output).toContain("1. Alpha");
        expect(output).toContain("Path: alpha.md");
        expect(output).toContain("Matched by: title");
        expect(output).toContain("Score:");
        expect(output).not.toContain("Snippet:");
      });
    });
  });

  describe("WHEN title mode has no matches", () => {
    describe("THEN an empty result is printed", () => {
      it("SHOULD print no results", async () => {
        const { configPath } = await createSearchFixture("title-empty");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "missing notebook",
              "--mode",
              "title",
              "--config",
              configPath,
            ],
            { from: "node" },
          );
        });

        expect(output).toBe("No results.");
      });
    });
  });

  describe("WHEN an unsupported mode is requested", () => {
    describe("THEN a clear invalid-option error is raised", () => {
      it("SHOULD reject non-keyword search modes", async () => {
        const errors: string[] = [];
        const program = createProgram()
          .exitOverride()
          .configureOutput({
            writeErr: (message) => {
              errors.push(message);
            },
          });

        await expect(
          program.parseAsync(
            ["node", "vaultgentic", "search", "sqlite-vec", "--mode", "hybrid"],
            { from: "node" },
          ),
        ).rejects.toThrow("process.exit unexpectedly called");
        expect(errors.join("")).toContain("Unsupported search mode: hybrid");
      });
    });
  });
});

describe("GIVEN the read command", () => {
  describe("WHEN a vault-relative note path is requested", () => {
    describe("THEN note content is printed", () => {
      it("SHOULD print the note as JSON", async () => {
        const { configPath } = await createSearchFixture("read-note");

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "read",
              "alpha.md",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject({
          type: "note",
          path: "alpha.md",
          content: expect.stringContaining("sqlite-vec extension"),
          truncated: false,
        });
      });
    });
  });

  describe("WHEN a numeric chunk id is requested", () => {
    describe("THEN indexed chunk content is printed", () => {
      it("SHOULD print the chunk as JSON", async () => {
        const { configPath, databasePath, vaultPath } =
          await createSearchFixture("read-chunk");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });
        const chunkId = readChunkIdByText(
          { databasePath, vaultPath },
          "sqlite-vec extension",
        );

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "read",
              String(chunkId),
              "--config",
              configPath,
              "--with-note-context",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject({
          type: "chunk",
          id: chunkId,
          path: "alpha.md",
          text: expect.stringContaining("sqlite-vec extension"),
          noteContext: {
            path: "alpha.md",
            title: "Alpha",
          },
        });
      });
    });
  });

  describe("WHEN maximum characters are requested", () => {
    describe("THEN content is truncated", () => {
      it("SHOULD print truncation details", async () => {
        const { configPath } = await createSearchFixture("read-truncated");

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "read",
              "alpha.md",
              "--config",
              configPath,
              "--max-chars",
              "5",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject({
          type: "note",
          content: "---\nt",
          truncated: true,
        });
      });
    });
  });

  describe("WHEN an ambiguous target is requested", () => {
    describe("THEN a clear read error is raised", () => {
      it("SHOULD reject non-md non-numeric targets", async () => {
        const { configPath } = await createSearchFixture("read-invalid");

        await expect(
          createProgram().parseAsync(
            ["node", "vaultgentic", "read", "alpha", "--config", configPath],
            { from: "node" },
          ),
        ).rejects.toThrow(
          "Read target must be a numeric chunk id or vault-relative .md note path",
        );
      });
    });
  });
});

async function createSearchFixture(name: string): Promise<{
  configPath: string;
  databasePath: string;
  vaultPath: string;
}> {
  const cwd = await mkdtemp(
    path.join(tmpdir(), `vaultgentic-cli-search-${name}-`),
  );
  const vaultPath = path.join(cwd, "vault");
  const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
  const configPath = path.join(cwd, "config.json");
  await mkdir(vaultPath);
  await writeFile(
    path.join(vaultPath, "alpha.md"),
    "---\ntitle: Alpha\n---\n\n# Alpha\n\n## Details\n\nThe sqlite-vec extension is searchable.",
  );
  await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n\nOther content.");
  await writeFile(configPath, JSON.stringify({ vaultPath, databasePath }));

  return { configPath, databasePath, vaultPath };
}

function readChunkIdByText(
  config: {
    vaultPath: string;
    databasePath: string;
  },
  text: string,
): number {
  const database = openSearchDatabase(config);
  try {
    const row = database
      .prepare("SELECT id FROM chunks WHERE text LIKE ? ORDER BY id LIMIT 1")
      .get(`%${text}%`) as { id: number };
    return row.id;
  } finally {
    database.close();
  }
}

function readIndexedPaths(config: {
  vaultPath: string;
  databasePath: string;
}): string[] {
  const database = openSearchDatabase(config);
  try {
    return database
      .prepare("SELECT path FROM notes ORDER BY path")
      .all()
      .map((row) => (row as { path: string }).path);
  } finally {
    database.close();
  }
}

async function captureConsoleLog(
  callback: () => Promise<void>,
): Promise<string> {
  const output: string[] = [];
  const previousLog = console.log;
  console.log = (message?: unknown) => {
    output.push(String(message));
  };

  try {
    await callback();
  } finally {
    console.log = previousLog;
  }

  return output.join("\n");
}

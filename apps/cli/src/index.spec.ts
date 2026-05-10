import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openSearchDatabase } from "@vaultgentic/core";
import {
  createProgram,
  isMainModule,
  packageVersion,
  runCli,
} from "./index.js";

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

      it("SHOULD detect the main module through an npm bin symlink", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-cli-bin-"));
        const entrypointPath = path.join(cwd, "dist", "index.js");
        const binPath = path.join(cwd, "bin", "vaultgentic");

        try {
          await mkdir(path.dirname(entrypointPath), { recursive: true });
          await mkdir(path.dirname(binPath), { recursive: true });
          await writeFile(entrypointPath, "#!/usr/bin/env node\n");
          await symlink(entrypointPath, binPath);

          expect(
            isMainModule(pathToFileURL(entrypointPath).href, binPath),
          ).toBe(true);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
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

  describe("WHEN human output is requested", () => {
    describe("THEN indexing progress is written to stderr", () => {
      it("SHOULD report progress without replacing the final summary", async () => {
        const { configPath } = await createSearchFixture("sync-progress");

        const stderrOutput = await captureStderr(async (stderr) => {
          const stdoutOutput = await captureConsoleLog(async () => {
            await createProgram({
              outputStream: { isTTY: true },
              progressStream: stderr,
            }).parseAsync(
              ["node", "vaultgentic", "index", "sync", "--config", configPath],
              { from: "node" },
            );
          });

          expect(stdoutOutput).toContain("Indexed");
          expect(stdoutOutput).toContain("2");
          expect(stdoutOutput).toContain("┌");
        });

        expect(stderrOutput).toContain("Scanning");
        expect(stderrOutput).toContain("Parsing/chunking");
        expect(stderrOutput).toContain("[█████░░░░░] 1/2");
        expect(stderrOutput).toContain("Index sync complete");
      });
    });
  });

  describe("WHEN JSON output is requested with a progress stream", () => {
    describe("THEN progress output is suppressed", () => {
      it("SHOULD keep stderr quiet so stdout remains machine-readable", async () => {
        const { configPath } = await createSearchFixture("sync-json-progress");

        const stderrOutput = await captureStderr(async (stderr) => {
          const stdoutOutput = await captureConsoleLog(async () => {
            await createProgram({ progressStream: stderr }).parseAsync(
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

          expect(JSON.parse(stdoutOutput)).toMatchObject({ indexed: 2 });
        });

        expect(stderrOutput).toBe("");
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
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
            chunkCount: 1,
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
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

        expect(output).toContain("Rank");
        expect(output).toContain("Chunk");
        expect(output).toContain("Title");
        expect(output).toContain("Path");
        expect(output).toContain("Matched");
        expect(output).toContain("Score");
        expect(output).toContain("1");
        expect(output).toContain("Alpha");
        expect(output).toContain("alpha.md");
        expect(output).toContain("┌");
        expect(output).toContain("keyword");
        expect(output).not.toContain("Snippet:");
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
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
            chunkId: expect.any(Number),
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

  describe("WHEN config sets a default search limit", () => {
    describe("THEN search uses the configured limit without a command override", () => {
      it("SHOULD return only the configured number of results", async () => {
        const { configPath, vaultPath } = await createSearchFixture(
          "configured-limit",
          { searchLimit: 1 },
        );
        await writeFile(
          path.join(vaultPath, "gamma.md"),
          "# Gamma\n\nAnother sqlite-vec searchable note.",
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
              "sqlite-vec",
              "--mode",
              "keyword",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toHaveLength(1);
      });
    });
  });

  describe("WHEN command search limit overrides config", () => {
    describe("THEN the explicit command limit is used", () => {
      it("SHOULD return the command-line number of results", async () => {
        const { configPath, vaultPath } = await createSearchFixture(
          "override-limit",
          { searchLimit: 1 },
        );
        await writeFile(
          path.join(vaultPath, "gamma.md"),
          "# Gamma\n\nAnother sqlite-vec searchable note.",
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
              "sqlite-vec",
              "--mode",
              "keyword",
              "--config",
              configPath,
              "--limit",
              "2",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toHaveLength(2);
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
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
            chunkId: null,
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
            chunkId: expect.any(Number),
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

  describe("WHEN default mode prints JSON output", () => {
    describe("THEN hybrid search results include fused component details", () => {
      it("SHOULD fuse keyword and title matches without duplicate note results", async () => {
        const { configPath } = await createSearchFixture("hybrid-json");
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "Alpha",
              "--config",
              configPath,
              "--limit",
              "1",
              "--json",
            ],
            { from: "node" },
          );
        });
        const results = JSON.parse(output) as Array<{
          rank: number;
          path: string;
          score: number;
          matchedBy: string[];
          componentScores: Record<string, { rank: number; score: number }>;
        }>;

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          rank: 1,
          path: "alpha.md",
          score: expect.any(Number),
          matchedBy: expect.arrayContaining(["keyword", "title"]),
          componentScores: {
            keyword: { rank: expect.any(Number), score: expect.any(Number) },
            title: { rank: expect.any(Number), score: expect.any(Number) },
          },
        });
      });
    });
  });

  describe("WHEN default mode has a title-only match", () => {
    describe("THEN missing component scores are omitted", () => {
      it("SHOULD include available component ranks without raw score comparison", async () => {
        const { configPath, vaultPath } = await createSearchFixture(
          "hybrid-missing-scores",
        );
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
              "--config",
              configPath,
              "--limit",
              "1",
              "--json",
            ],
            { from: "node" },
          );
        });
        const [result] = JSON.parse(output) as Array<{
          matchedBy: string[];
          componentScores: Record<string, { rank: number; score: number }>;
        }>;

        expect(result.matchedBy).toContain("title");
        expect(result.componentScores.title).toEqual({
          rank: expect.any(Number),
          score: expect.any(Number),
        });
        expect(result.componentScores.keyword).toBeUndefined();
      });
    });
  });

  describe("WHEN default mode prints human scores", () => {
    describe("THEN hybrid score details are shown", () => {
      it("SHOULD print fused score and component ranks", async () => {
        const { configPath } = await createSearchFixture("hybrid-human");
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
              "--config",
              configPath,
              "--scores",
            ],
            { from: "node" },
          );
        });

        expect(output).toContain("Matched by:");
        expect(output).toContain("Score:");
        expect(output).toContain("Component scores:");
        expect(output).toContain("title rank");
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
          await createProgram({ outputStream: { isTTY: true } }).parseAsync(
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

        expect(output).toContain("Rank");
        expect(output).toContain("Chunk");
        expect(output).toContain("1");
        expect(output).toContain("Alpha");
        expect(output).toContain("alpha.md");
        expect(output).toContain("note");
        expect(output).toContain("┌");
        expect(output).toContain("Matched");
        expect(output).toContain("title");
        expect(output).toContain("Score");
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
      it("SHOULD reject unknown search modes", async () => {
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
            ["node", "vaultgentic", "search", "sqlite-vec", "--mode", "bogus"],
            { from: "node" },
          ),
        ).rejects.toThrow("process.exit unexpectedly called");
        expect(errors.join("")).toContain("Unsupported search mode: bogus");
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

describe("GIVEN the CLI error runner", () => {
  describe("WHEN an expected command error is raised", () => {
    describe("THEN a pretty human error is printed", () => {
      it("SHOULD NOT print a stack trace by default", async () => {
        const output = await captureStderr(async (stderr) => {
          const exitCode = await runCli(
            [
              "node",
              "vaultgentic",
              "index",
              "status",
              "--config",
              "missing-config.json",
            ],
            { stderr },
          );

          expect(exitCode).toBe(1);
        });

        expect(output).toContain("Error: Could not read config");
        expect(output).toContain("Pass --config <path>");
        expect(output).not.toContain("ConfigServiceError");
        expect(output).not.toContain("\n    at ");
      });
    });
  });

  describe("WITH JSON output", () => {
    describe("WHEN an expected command error is raised", () => {
      describe("THEN a structured error is printed", () => {
        it("SHOULD preserve machine-readable output", async () => {
          const output = await captureStderr(async (stderr) => {
            const exitCode = await runCli(
              [
                "node",
                "vaultgentic",
                "index",
                "status",
                "--config",
                "missing-config.json",
                "--json",
              ],
              { stderr },
            );

            expect(exitCode).toBe(1);
          });

          expect(JSON.parse(output)).toMatchObject({
            error: {
              name: "ConfigServiceError",
              message: expect.stringContaining("Could not read config"),
              expected: true,
            },
          });
          expect(JSON.parse(output).error.stack).toBeUndefined();
        });
      });
    });
  });

  describe("WHEN JSON is provided after the option terminator", () => {
    describe("THEN it is not treated as an output flag", () => {
      it("SHOULD print a human error", async () => {
        const output = await captureStderr(async (stderr) => {
          const exitCode = await runCli(
            [
              "node",
              "vaultgentic",
              "index",
              "status",
              "--config",
              "missing-config.json",
              "--",
              "--json",
            ],
            { stderr },
          );

          expect(exitCode).toBe(1);
        });

        expect(output).toContain("Error: Could not read config");
        expect(() => JSON.parse(output)).toThrow();
      });
    });
  });

  describe("WITH debug enabled", () => {
    describe("WHEN an expected command error is raised", () => {
      describe("THEN debug details are printed", () => {
        it("SHOULD include stack traces", async () => {
          const output = await captureStderr(async (stderr) => {
            const exitCode = await runCli(
              [
                "node",
                "vaultgentic",
                "--debug",
                "index",
                "status",
                "--config",
                "missing-config.json",
              ],
              { stderr },
            );

            expect(exitCode).toBe(1);
          });

          expect(output).toContain("Debug details:");
          expect(output).toContain("ConfigServiceError");
          expect(output).toContain("Cause:");
        });
      });
    });
  });

  describe("WHEN a Commander argument error is raised", () => {
    describe("THEN the captured parser message is printed", () => {
      it("SHOULD include the invalid option context", async () => {
        const output = await captureStderr(async (stderr) => {
          const exitCode = await runCli(
            ["node", "vaultgentic", "search", "sqlite-vec", "--mode", "bogus"],
            { stderr },
          );

          expect(exitCode).toBe(1);
        });

        expect(output).toContain(
          "Error: option '--mode <mode>' argument 'bogus' is invalid",
        );
        expect(output).toContain("Unsupported search mode: bogus");
      });
    });
  });
});

async function createSearchFixture(
  name: string,
  options: { searchLimit?: number } = {},
): Promise<{
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
  await writeFile(
    configPath,
    JSON.stringify({
      vaultPath,
      databasePath,
      ...(options.searchLimit === undefined
        ? {}
        : { searchLimit: options.searchLimit }),
    }),
  );

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

async function captureStderr(
  callback: (
    stderr: Pick<NodeJS.WriteStream, "isTTY" | "write">,
  ) => Promise<void>,
): Promise<string> {
  let output = "";
  const stderr = {
    isTTY: false,
    write: (chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    },
  };

  await callback(stderr);

  return output;
}

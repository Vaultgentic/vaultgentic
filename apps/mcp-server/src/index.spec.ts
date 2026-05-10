import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMcpIndexRefreshCoordinator,
  createVaultgenticMcpServer,
  forbiddenMcpToolNameParts,
  mcpServerPackageName,
  mcpToolPrefix,
  plannedMcpToolNames,
  readToolInputSchema,
  searchToolInputSchema,
  sharedCorePackageName,
} from "./index.js";
import type { RefreshSearchIndexResult, SearchOutput } from "@vaultgentic/core";
import type {
  ReadVaultTargetOptions,
  ReadVaultTargetResult,
} from "@vaultgentic/core";

describe("GIVEN the MCP server skeleton", () => {
  describe("WHEN creating the server from shared config", () => {
    describe("THEN startup uses core services without exposing indexing tools", () => {
      it("SHOULD create a named MCP server and initialize the database", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath,
            databasePath,
          }),
        );

        const mcpServer = await createVaultgenticMcpServer({ configPath });

        expect(sharedCorePackageName).toBe("vaultgentic-core");
        expect(mcpServerPackageName).toBe("vaultgentic-mcp-server");
        expect(mcpServer.config).toMatchObject({ vaultPath, databasePath });
        expect(mcpServer.databaseStatus.databasePath).toBe(databasePath);
        expect(mcpServer.server).toBeDefined();
      });

      it("SHOULD refresh the index during startup", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath,
            databasePath,
          }),
        );

        let refreshCount = 0;
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshIndex: async () => {
            refreshCount += 1;
            return createRefreshResult(refreshCount);
          },
        });

        expect(refreshCount).toBe(1);
        expect(mcpServer.databaseStatus.noteCount).toBe(1);
      });

      it("SHOULD reserve only vaultgentic-prefixed search and read tool names", () => {
        expect(plannedMcpToolNames).toEqual([
          "vaultgentic_search",
          "vaultgentic_read",
        ]);
        expect(
          plannedMcpToolNames.every((name) => name.startsWith(mcpToolPrefix)),
        ).toBe(true);
      });

      it("SHOULD define future tool inputs with Zod", () => {
        expect(
          searchToolInputSchema.safeParse({ query: "local search", limit: 3 })
            .success,
        ).toBe(true);
        expect(
          readToolInputSchema.safeParse({ target: "note.md" }).success,
        ).toBe(true);
      });

      it("SHOULD NOT expose sync, file, rebuild, watch, or index tools", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({
            vaultPath,
            databasePath,
          }),
        );

        const mcpServer = await createVaultgenticMcpServer({ configPath });

        expect(mcpServer.toolNames).toEqual([
          "vaultgentic_search",
          "vaultgentic_read",
        ]);
        for (const forbiddenNamePart of forbiddenMcpToolNameParts) {
          expect(
            mcpServer.toolNames.some((toolName) =>
              toolName.includes(forbiddenNamePart),
            ),
          ).toBe(false);
        }
      });
    });
  });

  describe("WHEN MCP callers ask for a fresh index", () => {
    describe("THEN refresh work is serialized and throttled", () => {
      it("SHOULD share concurrent refreshes", async () => {
        const config = { vaultPath: "/vault", databasePath: "/db.sqlite" };
        let refreshCount = 0;
        const refreshIndex = async () => {
          refreshCount += 1;
          await Promise.resolve();
          return createRefreshResult(refreshCount);
        };
        const coordinator = createMcpIndexRefreshCoordinator(config, {
          refreshIndex,
          throttleMs: 0,
        });

        const [first, second] = await Promise.all([
          coordinator.ensureIndexFresh(),
          coordinator.ensureIndexFresh(),
        ]);

        expect(refreshCount).toBe(1);
        expect(first).toBe(second);
      });

      it("SHOULD NOT refresh again inside the throttle window", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        await mkdir(vaultPath);
        const config = { vaultPath, databasePath };
        let currentTime = 1_000;
        let refreshCount = 0;
        const coordinator = createMcpIndexRefreshCoordinator(config, {
          now: () => currentTime,
          refreshIndex: async () => {
            refreshCount += 1;
            return createRefreshResult(refreshCount);
          },
          throttleMs: 5_000,
        });

        const first = await coordinator.ensureIndexFresh();
        currentTime = 2_000;
        const second = await coordinator.ensureIndexFresh();

        expect(refreshCount).toBe(1);
        expect(first.sync.indexed).toBe(1);
        expect(second.sync.indexed).toBe(0);
      });
    });
  });

  describe("WHEN MCP callers search the vault", () => {
    describe("THEN vaultgentic_search uses shared search after refreshing internally", () => {
      it("SHOULD default to hybrid search with compact results and hidden scores", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        let refreshCount = 0;
        const searched: Array<{
          query: string;
          mode?: string;
          limit?: number;
          scope?: string;
          tags?: string[];
        }> = [];

        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshThrottleMs: 0,
          refreshIndex: async () => {
            refreshCount += 1;
            return createRefreshResult(refreshCount);
          },
          search: async (_config, options) => {
            searched.push(options);
            return [createSearchResult({ score: 12 })];
          },
        });

        const response = await mcpServer.search({ query: "local search" });

        expect(refreshCount).toBe(2);
        expect(searched).toEqual([{ query: "local search", mode: "hybrid" }]);
        expect(response.mode).toBe("hybrid");
        expect(response.results).toEqual([
          {
            rank: 1,
            path: "notes/search.md",
            title: "Search",
            chunkId: 7,
            matchedBy: ["keyword"],
            headingPath: ["Details"],
            snippet: "A compact match",
          },
        ]);
        expect(response.indexStatus.noteCount).toBe(2);
        expect(response.indexStatus).not.toHaveProperty("vaultPath");
        expect(response.indexStatus).not.toHaveProperty("databasePath");
        expect(response.refresh).toEqual({
          indexed: 2,
          skipped: 0,
          deleted: 0,
        });
        expect(response.refresh).not.toHaveProperty("files");
        expect(response.refresh).not.toHaveProperty("deletedPaths");
        expect(response.results[0]).not.toHaveProperty("score");
      });

      it("SHOULD support explicit modes, options, and optional scores", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const searched: Array<{
          query: string;
          mode?: string;
          limit?: number;
        }> = [];
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshIndex: async () => createRefreshResult(1),
          search: async (_config, options) => {
            searched.push(options);
            return [createSearchResult({ score: 0.25 })];
          },
        });

        const response = await mcpServer.search({
          query: "semantic idea",
          mode: "semantic",
          limit: 3,
          scope: "notes/",
          tags: ["project"],
          includeScores: true,
        });

        expect(searched).toEqual([
          {
            query: "semantic idea",
            mode: "semantic",
            limit: 3,
            scope: "notes/",
            tags: ["project"],
          },
        ]);
        expect(response.results[0]).toMatchObject({ score: 0.25 });
      });

      it("SHOULD reject oversized search inputs", () => {
        expect(
          searchToolInputSchema.safeParse({
            query: "x".repeat(1_001),
          }).success,
        ).toBe(false);
        expect(
          searchToolInputSchema.safeParse({
            query: "local search",
            tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
          }).success,
        ).toBe(false);
      });
    });
  });

  describe("WHEN MCP callers read from the vault", () => {
    describe("THEN vaultgentic_read uses shared read after refreshing internally", () => {
      it("SHOULD read note paths with compact index metadata", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        let refreshCount = 0;
        const reads: ReadVaultTargetOptions[] = [];
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshThrottleMs: 0,
          refreshIndex: async () => {
            refreshCount += 1;
            return createRefreshResult(refreshCount);
          },
          read: async (_config, options) => {
            reads.push(options);
            return createNoteReadResult({ content: "# Alpha" });
          },
        });

        const response = await mcpServer.read({ target: "alpha.md" });

        expect(refreshCount).toBe(2);
        expect(reads).toEqual([{ target: "alpha.md", maxChars: 20_000 }]);
        expect(response.result).toMatchObject({
          type: "note",
          path: "alpha.md",
          content: "# Alpha",
        });
        expect(response.indexStatus.noteCount).toBe(2);
        expect(response.indexStatus).not.toHaveProperty("vaultPath");
        expect(response.refresh).toEqual({
          indexed: 2,
          skipped: 0,
          deleted: 0,
        });
      });

      it("SHOULD read numeric chunk ids and pass metadata options", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const reads: ReadVaultTargetOptions[] = [];
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshIndex: async () => createRefreshResult(1),
          read: async (_config, options) => {
            reads.push(options);
            return createChunkReadResult({ text: "Chunk text" });
          },
        });

        const response = await mcpServer.read({
          target: 7,
          maxChars: 10,
          includeMetadata: true,
          includeNoteContext: true,
        });

        expect(reads).toEqual([
          {
            target: "7",
            maxChars: 10,
            withMetadata: true,
            withNoteContext: true,
          },
        ]);
        expect(response.result).toMatchObject({
          type: "chunk",
          id: 7,
          text: "Chunk text",
          noteContext: { path: "alpha.md" },
        });
      });

      it("SHOULD reject ambiguous string targets", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({ configPath });

        await expect(mcpServer.read({ target: "alpha" })).rejects.toThrow(
          "Read target must be a numeric chunk id or vault-relative .md note path",
        );
      });

      it("SHOULD reject traversal outside the vault through the shared service", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({ configPath });

        await expect(
          mcpServer.read({ target: "../escape.md" }),
        ).rejects.toThrow("Invalid read path");
      });

      it("SHOULD read changed notes after internal refresh", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(path.join(vaultPath, "alpha.md"), "Before");
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshThrottleMs: 0,
        });
        await writeFile(path.join(vaultPath, "alpha.md"), "After");

        const response = await mcpServer.read({ target: "alpha.md" });

        expect(response.result).toMatchObject({
          type: "note",
          content: "After",
        });
      });

      it("SHOULD report deleted chunk targets after internal refresh", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          path.join(vaultPath, "alpha.md"),
          "# Alpha\n\nChunk text",
        );
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshThrottleMs: 0,
        });
        await unlink(path.join(vaultPath, "alpha.md"));

        await expect(mcpServer.read({ target: 1 })).rejects.toThrow(
          "Chunk not found",
        );
      });

      it("SHOULD reject oversized read inputs", () => {
        expect(
          readToolInputSchema.safeParse({ target: `${"x".repeat(501)}.md` })
            .success,
        ).toBe(false);
        expect(
          readToolInputSchema.safeParse({ target: "alpha.md", maxChars: 0 })
            .success,
        ).toBe(false);
        expect(
          readToolInputSchema.safeParse({
            target: "alpha.md",
            maxChars: 200_001,
          }).success,
        ).toBe(false);
      });
    });
  });
});

function createRefreshResult(indexed: number): RefreshSearchIndexResult {
  return {
    sync: {
      indexed,
      skipped: 0,
      deleted: 0,
      files: [],
      deletedPaths: [],
    },
    status: {
      vaultPath: "/vault",
      databasePath: "/db.sqlite",
      schemaVersion: 1,
      noteCount: indexed,
      chunkCount: indexed,
      lastIndexedAt: Date.now(),
      sqlite: {
        ok: true,
        walEnabled: true,
        foreignKeysEnabled: true,
        fts5Available: true,
        sqliteVecAvailable: true,
      },
      vectors: {
        ready: true,
        chunkEmbeddingCount: indexed,
        modelId: "test",
        dimension: 1,
        normalized: true,
        chunkerVersion: "test",
      },
    },
  };
}

function createSearchResult(options: { score: number }): SearchOutput {
  return {
    chunkId: 7,
    path: "notes/search.md",
    title: "Search",
    headingPath: ["Details"],
    snippet: "A compact match",
    score: options.score,
    rank: 1,
    chunkIndex: 0,
    matchedBy: ["keyword"],
  };
}

function createNoteReadResult(options: {
  content: string;
}): ReadVaultTargetResult {
  return {
    type: "note",
    path: "alpha.md",
    content: options.content,
    truncated: false,
    originalLength: options.content.length,
  };
}

function createChunkReadResult(options: {
  text: string;
}): ReadVaultTargetResult {
  return {
    type: "chunk",
    id: 7,
    path: "alpha.md",
    title: "Alpha",
    headingPath: ["Alpha"],
    chunkIndex: 0,
    text: options.text,
    truncated: false,
    originalLength: options.text.length,
    noteContext: {
      path: "alpha.md",
      title: "Alpha",
      aliases: [],
      tags: [],
      frontmatter: {},
      links: [],
      indexedAt: Date.now(),
    },
  };
}

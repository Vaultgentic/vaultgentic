import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RefreshSearchIndexResult, SearchOutput } from "@vaultgentic/core";
import type {
  PatchVaultNoteOptions,
  PatchVaultNoteResult,
  ReadVaultTargetOptions,
  ReadVaultTargetResult,
  RemoveVaultNoteOptions,
  RemoveVaultNoteResult,
  WriteVaultNoteOptions,
  WriteVaultNoteResult,
} from "@vaultgentic/core";
import { VaultReadError } from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { searchVault as searchVaultFromSource } from "../../../packages/core/src/search.js";
import {
  createMcpIndexRefreshCoordinator,
  createVaultgenticMcpServer,
  forbiddenMcpToolNameParts,
  mcpServerPackageName,
  mcpToolPrefix,
  patchToolInputSchema,
  plannedMcpToolNames,
  readToolInputSchema,
  removeToolInputSchema,
  searchToolInputSchema,
  sharedCorePackageName,
  writeToolInputSchema,
} from "./index.js";

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

      it("SHOULD reserve only vaultgentic-prefixed search read and write tool names", () => {
        expect(plannedMcpToolNames).toEqual([
          "vaultgentic_search",
          "vaultgentic_read",
          "vaultgentic_write",
          "vaultgentic_patch",
          "vaultgentic_remove",
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
        expect(
          writeToolInputSchema.safeParse({ path: "note.md", body: "Body" })
            .success,
        ).toBe(true);
        expect(
          patchToolInputSchema.safeParse({
            path: "note.md",
            patch: createPatchText("note.md"),
          }).success,
        ).toBe(true);
        expect(
          removeToolInputSchema.safeParse({ path: "note.md" }).success,
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
          "vaultgentic_write",
          "vaultgentic_patch",
          "vaultgentic_remove",
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
          scope?: string;
          tags?: string[];
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
          filter: { kind: "scope", scope: "notes/", tags: ["project"] },
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
            filter: {
              kind: "tags",
              tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
            },
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

  describe("WHEN MCP callers write to the vault", () => {
    describe("THEN vaultgentic_write uses the shared write service", () => {
      it("SHOULD write notes with metadata only responses", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const writes: WriteVaultNoteOptions[] = [];
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          write: async (_config, options) => {
            writes.push(options);
            return createWriteResult({
              path: options.path,
              operation: "created",
              indexed: true,
            });
          },
        });

        const response = await mcpServer.write({
          path: "notes/alpha.md",
          body: "# Alpha",
          tags: ["project"],
          aliases: ["Alpha note"],
        });

        expect(writes).toEqual([
          {
            path: "notes/alpha.md",
            body: "# Alpha",
            frontmatter: {
              tags: ["project"],
              aliases: ["Alpha note"],
            },
          },
        ]);
        expect(response).toEqual({
          result: {
            path: "notes/alpha.md",
            operation: "created",
            indexed: true,
          },
        });
        expect(JSON.stringify(response)).not.toContain("# Alpha");
      });

      it("SHOULD reject invalid write tool input", async () => {
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
          mcpServer.write({
            path: "alpha.md",
            body: "# Alpha",
            tags: ["project", ""],
          }),
        ).rejects.toMatchObject({
          code: "invalid_tool_input",
          expected: true,
        });
      });
    });
  });

  describe("WHEN MCP callers patch the vault", () => {
    describe("THEN vaultgentic_patch uses the shared patch service", () => {
      it("SHOULD patch notes with metadata only responses", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const patches: PatchVaultNoteOptions[] = [];
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          patch: async (_config, options) => {
            patches.push(options);
            return createPatchResult({ path: options.path, indexed: true });
          },
        });

        const response = await mcpServer.patch({
          path: "notes/alpha.md",
          patch: createPatchText("notes/alpha.md", "Secret body"),
          expectedFileHash:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        });

        expect(patches).toEqual([
          {
            path: "notes/alpha.md",
            patch: createPatchText("notes/alpha.md", "Secret body"),
            expectedFileHash:
              "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        ]);
        expect(response).toEqual({
          result: { path: "notes/alpha.md", indexed: true },
        });
        expect(JSON.stringify(response)).not.toContain("Secret body");
      });

      it("SHOULD reject invalid patch tool input", async () => {
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
          mcpServer.patch({ path: "alpha.md", patch: "   \n" }),
        ).rejects.toMatchObject({
          code: "invalid_tool_input",
          expected: true,
        });
      });
    });
  });

  describe("WHEN MCP callers remove from the vault", () => {
    describe("THEN vaultgentic_remove uses the shared remove service", () => {
      it("SHOULD remove notes with metadata only responses", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const removes: RemoveVaultNoteOptions[] = [];
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          remove: async (_config, options) => {
            removes.push(options);
            return createRemoveResult({ path: options.path });
          },
        });

        const response = await mcpServer.remove({
          path: "notes/alpha.md",
          expectedFileHash:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        });

        expect(removes).toEqual([
          {
            path: "notes/alpha.md",
            expectedFileHash:
              "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        ]);
        expect(response).toEqual({
          result: {
            path: "notes/alpha.md",
            operation: "archived",
            archivedPath: ".vaultgentic/archive/notes/alpha.md",
            indexRemoved: true,
          },
        });
        expect(JSON.stringify(response)).not.toContain("Secret body");
      });

      it("SHOULD reject invalid remove tool input", async () => {
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
          mcpServer.remove({ path: "", expectedFileHash: "sha256:not-hex" }),
        ).rejects.toMatchObject({
          code: "invalid_tool_input",
          expected: true,
        });
      });
    });
  });

  describe("WHEN MCP callers invoke registered tools", () => {
    describe("THEN registered callbacks return MCP-shaped results", () => {
      it("SHOULD return known search hits through vaultgentic_search", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshIndex: async () => createRefreshResult(1),
          search: async () => [createSearchResult({ score: 0.9 })],
        });

        const result = await callRegisteredTool(
          mcpServer.server,
          "vaultgentic_search",
          {
            query: "known hit",
          },
        );

        expect(readToolJson(result)).toMatchObject({
          results: [{ path: "notes/search.md", snippet: "A compact match" }],
        });
        expect(result.isError).toBeUndefined();
      });

      it("SHOULD return known search hits through the MCP client path", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          path.join(vaultPath, "alpha.md"),
          "# Alpha\n\nOpenCode should find this unique needle.",
        );
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshThrottleMs: 0,
          search: searchVaultFromSource,
        });
        const client = new Client({ name: "agent-client", version: "test" });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await mcpServer.server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
          const result = await client.callTool({
            name: "vaultgentic_search",
            arguments: {
              query: "Can OpenCode find the unique needle?",
              mode: "keyword",
            },
          });

          expect(readToolJson(result)).toMatchObject({
            results: [{ path: "alpha.md" }],
          });
        } finally {
          await client.close();
        }
      });

      it("SHOULD return read content through vaultgentic_read", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          refreshIndex: async () => createRefreshResult(1),
          read: async () => createNoteReadResult({ content: "# Registered" }),
        });

        const result = await callRegisteredTool(
          mcpServer.server,
          "vaultgentic_read",
          {
            target: "alpha.md",
          },
        );

        expect(readToolJson(result)).toMatchObject({
          result: { type: "note", content: "# Registered" },
        });
        expect(result.isError).toBeUndefined();
      });

      it("SHOULD return structured sanitized errors through vaultgentic_read", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          read: async () => {
            throw new VaultReadError("Note not found: missing.md");
          },
        });

        const result = await callRegisteredTool(
          mcpServer.server,
          "vaultgentic_read",
          {
            target: "missing.md",
          },
        );

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          code: "not_found",
          expected: true,
          message: "Note not found: missing.md",
        });
        expect(JSON.stringify(result)).not.toContain(vaultPath);
      });

      it("SHOULD return write metadata through vaultgentic_write", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          write: async () =>
            createWriteResult({
              path: "alpha.md",
              operation: "updated",
              indexed: true,
            }),
        });

        const result = await callRegisteredTool(
          mcpServer.server,
          "vaultgentic_write",
          {
            path: "alpha.md",
            body: "# Registered",
          },
        );

        expect(readToolJson(result)).toEqual({
          result: { path: "alpha.md", operation: "updated", indexed: true },
        });
        expect(result.isError).toBeUndefined();
      });

      it("SHOULD expose agent guidance in registered tool descriptions", async () => {
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

        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_search"),
        ).toContain("Omit filter for unscoped search");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_search"),
        ).toContain("filter.kind='scope'");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_search"),
        ).toContain("filter.kind='path'");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_search"),
        ).toContain("Never pass empty strings");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_search"),
        ).toContain("try title mode once");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_read"),
        ).toContain("vault-relative .md path or an indexed numeric chunk id");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_read"),
        ).toContain("includeMetadata=true");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_write"),
        ).toContain("whole-note replacement");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_write"),
        ).toContain("body excludes frontmatter");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_patch"),
        ).toContain("Vaultgentic agent patch");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_patch"),
        ).toContain("*** Update File: <path>");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_patch"),
        ).toContain("pass expectedFileHash");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_remove"),
        ).toContain("pass expectedFileHash");
        expect(
          getRegisteredToolDescription(mcpServer.server, "vaultgentic_remove"),
        ).toContain("Configured to archive removed notes under");
      });

      it("SHOULD return patch metadata through vaultgentic_patch", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          patch: async () =>
            createPatchResult({ path: "alpha.md", indexed: true }),
        });

        const result = await callRegisteredTool(
          mcpServer.server,
          "vaultgentic_patch",
          {
            path: "alpha.md",
            patch: createPatchText("alpha.md", "Registered patch"),
          },
        );

        expect(readToolJson(result)).toEqual({
          result: { path: "alpha.md", indexed: true },
        });
        expect(JSON.stringify(result)).not.toContain("Registered patch");
        expect(result.isError).toBeUndefined();
      });

      it("SHOULD return remove metadata through vaultgentic_remove", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-mcp-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const mcpServer = await createVaultgenticMcpServer({
          configPath,
          remove: async () => createRemoveResult({ path: "alpha.md" }),
        });

        const result = await callRegisteredTool(
          mcpServer.server,
          "vaultgentic_remove",
          {
            path: "alpha.md",
          },
        );

        expect(readToolJson(result)).toEqual({
          result: {
            path: "alpha.md",
            operation: "archived",
            archivedPath: ".vaultgentic/archive/alpha.md",
            indexRemoved: true,
          },
        });
        expect(result.isError).toBeUndefined();
      });
    });
  });
});

type RegisteredMcpServer = {
  _registeredTools: Record<
    string,
    {
      description?: string;
      handler: (
        input: Record<string, unknown>,
        extra: unknown,
      ) => Promise<CallToolResult>;
    }
  >;
};

async function callRegisteredTool(
  server: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const registeredServer = server as RegisteredMcpServer;
  return registeredServer._registeredTools[name].handler(input, {});
}

function getRegisteredToolDescription(server: unknown, name: string): string {
  const registeredServer = server as RegisteredMcpServer;
  const description = registeredServer._registeredTools[name].description;
  if (description === undefined) {
    throw new Error(`Expected ${name} to have a description`);
  }

  return description;
}

function readToolJson(result: CallToolResult): Record<string, unknown> {
  const [content] = result.content ?? [];
  if (content?.type !== "text") {
    throw new Error("Expected a text MCP tool result");
  }

  return JSON.parse(content.text) as Record<string, unknown>;
}

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

function createWriteResult(options: {
  path: string;
  operation: WriteVaultNoteResult["operation"];
  indexed: boolean;
}): WriteVaultNoteResult {
  return {
    path: options.path,
    operation: options.operation,
    indexed: options.indexed,
  };
}

function createPatchText(path: string, replacement = "Updated body"): string {
  return `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-Old body\n+${replacement}\n`;
}

function createPatchResult(options: {
  path: string;
  indexed: boolean;
}): PatchVaultNoteResult {
  return {
    path: options.path,
    indexed: options.indexed,
  };
}

function createRemoveResult(options: { path: string }): RemoveVaultNoteResult {
  return {
    path: options.path,
    operation: "archived",
    archivedPath: `.vaultgentic/archive/${options.path}`,
    indexRemoved: true,
  };
}

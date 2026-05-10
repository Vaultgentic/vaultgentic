import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import type { RefreshSearchIndexResult } from "@vaultgentic/core";

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

        expect(mcpServer.toolNames).toEqual([]);
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

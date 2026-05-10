import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RefreshSearchIndexResult } from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { createMcpIndexRefreshCoordinator } from "./refresh.js";

describe("GIVEN an MCP index refresh coordinator", () => {
  describe("WHEN callers request a fresh index", () => {
    describe("THEN refresh work is serialized and throttled", () => {
      it("SHOULD share concurrent refreshes", async () => {
        const config = { vaultPath: "/vault", databasePath: "/db.sqlite" };
        let refreshCount = 0;
        const refresh = async () => {
          refreshCount += 1;
          await Promise.resolve();
          return createRefreshResult(refreshCount);
        };
        const coordinator = createMcpIndexRefreshCoordinator(config, {
          refreshIndex: refresh,
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
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-refresh-"));
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
        expect(second.sync).toMatchObject({ cached: true });
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

import { describe, expect, it } from "vitest";
import { createSearchToolHandler, searchToolInputSchema } from "./search.js";
import type { RefreshSearchIndexResult, SearchOutput } from "@vaultgentic/core";

describe("GIVEN the MCP search tool", () => {
  describe("WHEN searching the vault", () => {
    describe("THEN inputs and outputs are shaped for MCP callers", () => {
      it("SHOULD default to hybrid search and hide scores", async () => {
        const searched: unknown[] = [];
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async (_config, options) => {
            searched.push(options);
            return [createSearchResult(0.5)];
          },
        });

        const response = await search({ query: "alpha" });

        expect(searched).toEqual([{ query: "alpha", mode: "hybrid" }]);
        expect(response.results[0]).toMatchObject({
          rank: 1,
          path: "alpha.md",
          chunkId: 7,
        });
        expect(response.results[0]).not.toHaveProperty("score");
      });

      it("SHOULD include scores when requested", async () => {
        const search = createSearchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          search: async () => [createSearchResult(0.5)],
        });

        const response = await search({ query: "alpha", includeScores: true });

        expect(response.results[0]).toMatchObject({ score: 0.5 });
      });

      it("SHOULD reject oversized search inputs", () => {
        expect(
          searchToolInputSchema.safeParse({ query: "x".repeat(1_001) }).success,
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

function createSearchResult(score: number): SearchOutput {
  return {
    chunkId: 7,
    path: "alpha.md",
    title: "Alpha",
    headingPath: ["Alpha"],
    snippet: "A compact match",
    score,
    rank: 1,
    chunkIndex: 0,
    matchedBy: ["keyword"],
  };
}

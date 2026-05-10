import { describe, expect, it } from "vitest";
import { createReadToolHandler, readToolInputSchema } from "./read.js";
import type { ReadVaultTargetOptions } from "@vaultgentic/core";
import type { RefreshSearchIndexResult } from "@vaultgentic/core";

describe("GIVEN the MCP read tool", () => {
  describe("WHEN reading vault targets", () => {
    describe("THEN inputs are validated and delegated to the shared read service", () => {
      it("SHOULD convert numeric targets and map MCP options", async () => {
        const reads: ReadVaultTargetOptions[] = [];
        const read = createReadToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(2),
          read: async (_config, options) => {
            reads.push(options);
            return {
              type: "chunk",
              id: 7,
              path: "alpha.md",
              title: "Alpha",
              headingPath: ["Alpha"],
              chunkIndex: 0,
              text: "Chunk text",
              truncated: false,
              originalLength: 10,
            };
          },
        });

        const response = await read({
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
        expect(response.result).toMatchObject({ type: "chunk", id: 7 });
        expect(response.indexStatus.noteCount).toBe(2);
        expect(response.refresh).toEqual({
          indexed: 2,
          skipped: 0,
          deleted: 0,
        });
      });

      it("SHOULD cap default read bodies", async () => {
        const reads: ReadVaultTargetOptions[] = [];
        const read = createReadToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          ensureIndexFresh: async () => createRefreshResult(1),
          read: async (_config, options) => {
            reads.push(options);
            return {
              type: "note",
              path: "alpha.md",
              content: "Alpha",
              truncated: false,
              originalLength: 5,
            };
          },
        });

        await read({ target: "alpha.md" });

        expect(reads).toEqual([{ target: "alpha.md", maxChars: 20_000 }]);
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

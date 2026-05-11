import type {
  RemoveVaultNoteOptions,
  RemoveVaultNoteResult,
} from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { createRemoveToolHandler, removeToolInputSchema } from "./remove.js";

describe("GIVEN the MCP remove tool", () => {
  describe("WHEN removing vault notes", () => {
    describe("THEN inputs are validated and delegated to the shared remove service", () => {
      it("SHOULD pass path and expected file hash to the shared remove service", async () => {
        const removes: RemoveVaultNoteOptions[] = [];
        const remove = createRemoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          remove: async (_config, options) => {
            removes.push(options);
            return createRemoveResult({ path: options.path });
          },
        });

        const response = await remove({
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
      });

      it("SHOULD omit missing expected file hash from delegated options", async () => {
        const removes: RemoveVaultNoteOptions[] = [];
        const remove = createRemoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          remove: async (_config, options) => {
            removes.push(options);
            return createRemoveResult({ path: options.path });
          },
        });

        await remove({ path: "alpha.md" });

        expect(removes).toEqual([{ path: "alpha.md" }]);
      });

      it("SHOULD return metadata only", async () => {
        const remove = createRemoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          remove: async () => ({
            path: "alpha.md",
            operation: "deleted",
            indexRemoved: false,
            warning:
              "Note was removed, but search index cleanup failed. Search results may be stale.",
          }),
        });

        const response = await remove({ path: "alpha.md" });

        expect(response).toEqual({
          result: {
            path: "alpha.md",
            operation: "deleted",
            indexRemoved: false,
            warning:
              "Note was removed, but search index cleanup failed. Search results may be stale.",
          },
        });
        expect(JSON.stringify(response)).not.toContain("Secret body");
      });

      it("SHOULD reject invalid remove inputs", () => {
        expect(removeToolInputSchema.safeParse({ path: "" }).success).toBe(
          false,
        );
        expect(
          removeToolInputSchema.safeParse({
            path: "alpha.md",
            expectedFileHash: "sha256:not-hex",
          }).success,
        ).toBe(false);
      });

      it("SHOULD throw structured remove errors", async () => {
        const remove = createRemoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          remove: async () => {
            throw Object.assign(
              new Error("Remove path must be an existing markdown file"),
              { expected: true as const },
            );
          },
        });

        await expect(remove({ path: "missing.md" })).rejects.toMatchObject({
          name: "VaultgenticMcpToolError",
          code: "path_rejected",
          expected: true,
          details: {
            code: "path_rejected",
            expected: true,
          },
        });
      });
    });
  });
});

function createRemoveResult(options: { path: string }): RemoveVaultNoteResult {
  return {
    path: options.path,
    operation: "archived",
    archivedPath: `.vaultgentic/archive/${options.path}`,
    indexRemoved: true,
  };
}

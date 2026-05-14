import type {
  MoveVaultNoteOptions,
  MoveVaultNoteResult,
} from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { createMoveToolHandler, moveToolInputSchema } from "./move.js";

describe("GIVEN the MCP move tool", () => {
  describe("WHEN moving vault notes", () => {
    describe("THEN inputs are validated and delegated to the shared move service", () => {
      it("SHOULD pass paths expected hash overwrite and pruning preference", async () => {
        const moves: MoveVaultNoteOptions[] = [];
        const move = createMoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          move: async (_config, options) => {
            moves.push(options);
            return createMoveResult(options);
          },
        });

        const response = await move({
          fromPath: "notes/alpha.md",
          toPath: "notes/beta.md",
          expectedFileHash:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          overwrite: true,
          pruneEmptyParents: false,
        });

        expect(moves).toEqual([
          {
            fromPath: "notes/alpha.md",
            toPath: "notes/beta.md",
            expectedFileHash:
              "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            overwrite: true,
            pruneEmptyParents: false,
          },
        ]);
        expect(response).toEqual({
          result: {
            fromPath: "notes/alpha.md",
            toPath: "notes/beta.md",
            moved: true,
            overwritten: true,
            prunedDirectories: [],
          },
        });
      });

      it("SHOULD omit missing optional values from delegated options", async () => {
        const moves: MoveVaultNoteOptions[] = [];
        const move = createMoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          move: async (_config, options) => {
            moves.push(options);
            return createMoveResult(options);
          },
        });

        await move({ fromPath: "alpha.md", toPath: "beta.md" });

        expect(moves).toEqual([{ fromPath: "alpha.md", toPath: "beta.md" }]);
      });

      it("SHOULD reject invalid move inputs", () => {
        expect(
          moveToolInputSchema.safeParse({ fromPath: "", toPath: "beta.md" })
            .success,
        ).toBe(false);
        expect(
          moveToolInputSchema.safeParse({
            fromPath: "alpha.md",
            toPath: "beta.md",
            expectedFileHash: "sha256:not-hex",
          }).success,
        ).toBe(false);
      });

      it("SHOULD throw structured move errors", async () => {
        const move = createMoveToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          move: async () => {
            throw Object.assign(
              new Error("Move source must be an existing markdown file"),
              { expected: true as const },
            );
          },
        });

        await expect(
          move({ fromPath: "missing.md", toPath: "beta.md" }),
        ).rejects.toMatchObject({
          name: "VaultgenticMcpToolError",
          code: "path_rejected",
          expected: true,
        });
      });
    });
  });
});

function createMoveResult(options: MoveVaultNoteOptions): MoveVaultNoteResult {
  return {
    fromPath: options.fromPath,
    toPath: options.toPath,
    moved: true,
    overwritten: options.overwrite === true,
    prunedDirectories: [],
  };
}

import type {
  PatchVaultNoteOptions,
  PatchVaultNoteResult,
} from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { createPatchToolHandler, patchToolInputSchema } from "./patch.js";

describe("GIVEN the MCP patch tool", () => {
  describe("WHEN patching vault notes", () => {
    describe("THEN inputs are validated and delegated to the shared patch service", () => {
      it("SHOULD pass path patch and expected file hash to the shared patch service", async () => {
        const patches: PatchVaultNoteOptions[] = [];
        const patch = createPatchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          patch: async (_config, options) => {
            patches.push(options);
            return createPatchResult({ path: options.path, indexed: true });
          },
        });

        const response = await patch({
          path: "notes/alpha.md",
          patch: createPatchText("notes/alpha.md"),
          expectedFileHash:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        });

        expect(patches).toEqual([
          {
            path: "notes/alpha.md",
            patch: createPatchText("notes/alpha.md"),
            expectedFileHash:
              "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        ]);
        expect(response).toEqual({
          result: {
            path: "notes/alpha.md",
            indexed: true,
          },
        });
      });

      it("SHOULD omit missing expected file hash from delegated options", async () => {
        const patches: PatchVaultNoteOptions[] = [];
        const patch = createPatchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          patch: async (_config, options) => {
            patches.push(options);
            return createPatchResult({ path: options.path, indexed: true });
          },
        });

        await patch({ path: "alpha.md", patch: createPatchText("alpha.md") });

        expect(patches).toEqual([
          { path: "alpha.md", patch: createPatchText("alpha.md") },
        ]);
      });

      it("SHOULD return metadata only", async () => {
        const patch = createPatchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          patch: async () => ({
            path: "alpha.md",
            indexed: false,
            warning:
              "Note was patched, but indexing failed. Search results may be stale.",
          }),
        });

        const response = await patch({
          path: "alpha.md",
          patch: createPatchText("alpha.md", "Secret body"),
        });

        expect(response).toEqual({
          result: {
            path: "alpha.md",
            indexed: false,
            warning:
              "Note was patched, but indexing failed. Search results may be stale.",
          },
        });
        expect(JSON.stringify(response)).not.toContain("Secret body");
      });

      it("SHOULD reject invalid patch inputs", () => {
        expect(
          patchToolInputSchema.safeParse({
            path: "",
            patch: createPatchText("alpha.md"),
          }).success,
        ).toBe(false);
        expect(
          patchToolInputSchema.safeParse({ path: "alpha.md", patch: "" })
            .success,
        ).toBe(false);
        expect(
          patchToolInputSchema.safeParse({ path: "alpha.md", patch: "   \n" })
            .success,
        ).toBe(false);
        expect(
          patchToolInputSchema.safeParse({
            path: "alpha.md",
            patch: createPatchText("alpha.md"),
            expectedFileHash: "sha256:not-hex",
          }).success,
        ).toBe(false);
      });

      it("SHOULD throw structured patch errors", async () => {
        const patch = createPatchToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          patch: async () => {
            throw Object.assign(
              new Error("Patch hunks did not apply cleanly"),
              {
                expected: true as const,
              },
            );
          },
        });

        await expect(
          patch({ path: "alpha.md", patch: createPatchText("alpha.md") }),
        ).rejects.toMatchObject({
          name: "VaultgenticMcpToolError",
          code: "vaultgentic_error",
          expected: true,
          details: {
            code: "vaultgentic_error",
            expected: true,
          },
        });
      });
    });
  });
});

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

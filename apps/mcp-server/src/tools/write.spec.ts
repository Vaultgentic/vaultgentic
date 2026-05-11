import type {
  WriteVaultNoteOptions,
  WriteVaultNoteResult,
} from "@vaultgentic/core";
import { describe, expect, it } from "vitest";
import { createWriteToolHandler, writeToolInputSchema } from "./write.js";

describe("GIVEN the MCP write tool", () => {
  describe("WHEN writing vault notes", () => {
    describe("THEN inputs are validated and delegated to the shared write service", () => {
      it("SHOULD pass path body and frontmatter to the shared write service", async () => {
        const writes: WriteVaultNoteOptions[] = [];
        const write = createWriteToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          write: async (_config, options) => {
            writes.push(options);
            return createWriteResult({
              path: options.path,
              operation: "created",
            });
          },
        });

        const response = await write({
          path: "notes/alpha.md",
          body: "# Alpha",
          frontmatter: { title: "Alpha", priority: 1 },
        });

        expect(writes).toEqual([
          {
            path: "notes/alpha.md",
            body: "# Alpha",
            frontmatter: { title: "Alpha", priority: 1 },
          },
        ]);
        expect(response).toEqual({
          result: {
            path: "notes/alpha.md",
            operation: "created",
            indexed: true,
          },
        });
      });

      it("SHOULD merge tags and aliases into frontmatter", async () => {
        const writes: WriteVaultNoteOptions[] = [];
        const write = createWriteToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          write: async (_config, options) => {
            writes.push(options);
            return createWriteResult({
              path: options.path,
              operation: "updated",
            });
          },
        });

        await write({
          path: "notes/alpha.md",
          body: "# Alpha",
          frontmatter: { title: "Alpha" },
          tags: ["project", "core"],
          aliases: ["A note"],
        });

        expect(writes).toEqual([
          {
            path: "notes/alpha.md",
            body: "# Alpha",
            frontmatter: {
              title: "Alpha",
              tags: ["project", "core"],
              aliases: ["A note"],
            },
          },
        ]);
      });

      it("SHOULD return metadata only", async () => {
        const write = createWriteToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          write: async () => ({
            path: "alpha.md",
            operation: "created",
            indexed: false,
            warning:
              "Note was written, but indexing failed. Search results may be stale.",
          }),
        });

        const response = await write({ path: "alpha.md", body: "Secret body" });

        expect(response).toEqual({
          result: {
            path: "alpha.md",
            operation: "created",
            indexed: false,
            warning:
              "Note was written, but indexing failed. Search results may be stale.",
          },
        });
        expect(JSON.stringify(response)).not.toContain("Secret body");
      });

      it("SHOULD reject invalid tags and aliases", () => {
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            tags: ["project", 7],
          }).success,
        ).toBe(false);
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            aliases: [""],
          }).success,
        ).toBe(false);
      });

      it("SHOULD reject invalid frontmatter keys", () => {
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            frontmatter: { "bad.key": "value" },
          }).success,
        ).toBe(false);
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            frontmatter: { constructor: "value" },
          }).success,
        ).toBe(false);
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            frontmatter: { safe: { constructor: "value" } },
          }).success,
        ).toBe(false);
      });

      it("SHOULD reject oversized or unsafe frontmatter values", () => {
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            frontmatter: { title: "x".repeat(10_001) },
          }).success,
        ).toBe(false);
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            frontmatter: { rank: Number.NaN },
          }).success,
        ).toBe(false);
        expect(
          writeToolInputSchema.safeParse({
            path: "alpha.md",
            body: "# Alpha",
            frontmatter: {
              nested: { one: { two: { three: { four: { five: "deep" } } } } },
            },
          }).success,
        ).toBe(false);
      });

      it("SHOULD throw structured write errors", async () => {
        const write = createWriteToolHandler({
          config: { vaultPath: "/vault", databasePath: "/db.sqlite" },
          write: async () => {
            throw Object.assign(
              new Error("Write path must be vault-relative"),
              { expected: true as const },
            );
          },
        });

        await expect(
          write({ path: "../escape.md", body: "# Escape" }),
        ).rejects.toMatchObject({
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

function createWriteResult(options: {
  path: string;
  operation: WriteVaultNoteResult["operation"];
}): WriteVaultNoteResult {
  return {
    path: options.path,
    operation: options.operation,
    indexed: true,
  };
}

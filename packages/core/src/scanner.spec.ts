import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { scanVaultFiles } from "./scanner.js";

describe("GIVEN vault file scanning", () => {
  describe("WHEN scanning a vault with nested Markdown notes", () => {
    describe("THEN only vault-relative Markdown paths are returned", () => {
      test("SHOULD return sorted Markdown metadata", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-"),
        );
        await mkdir(path.join(vaultPath, "folder", "nested"), {
          recursive: true,
        });
        await writeFile(path.join(vaultPath, "z.md"), "# Z\n");
        await writeFile(path.join(vaultPath, "folder", "a.md"), "# A\n");
        await writeFile(
          path.join(vaultPath, "folder", "nested", "b.txt"),
          "not a note",
        );

        const files = await scanVaultFiles({ vaultPath });

        expect(files.map((file) => file.path)).toEqual(["folder/a.md", "z.md"]);
        expect(files).toEqual(
          files.map((file) => ({
            path: file.path,
            mtime_ms: expect.any(Number),
            size_bytes: expect.any(Number),
          })),
        );
        expect(files[0]?.content_hash).toBeUndefined();
      });
    });
  });

  describe("WHEN a POSIX filename contains a backslash", () => {
    describe("THEN the backslash is preserved as part of the filename", () => {
      const testBackslashFilename =
        process.platform === "win32" ? test.skip : test;

      testBackslashFilename(
        "SHOULD not treat it as a path separator",
        async () => {
          const vaultPath = await mkdtemp(
            path.join(tmpdir(), "vaultgentic-scan-backslash-"),
          );
          await writeFile(path.join(vaultPath, "a\\b.md"), "# Backslash\n");

          const files = await scanVaultFiles({ vaultPath });

          expect(files.map((file) => file.path)).toEqual(["a\\b.md"]);
        },
      );
    });
  });

  describe("WHEN configured and default ignored paths are present", () => {
    describe("THEN ignored files and descendants are skipped", () => {
      test("SHOULD honor exact ignored paths and ignored directories", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-"),
        );
        await mkdir(path.join(vaultPath, "archive"), { recursive: true });
        await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
        await writeFile(path.join(vaultPath, "keep.md"), "keep");
        await writeFile(path.join(vaultPath, "skip.md"), "skip");
        await writeFile(path.join(vaultPath, "archive", "old.md"), "old");
        await writeFile(
          path.join(vaultPath, ".obsidian", "config.md"),
          "config",
        );

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["archive", "skip.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });
    });
  });

  describe("WHEN a POSIX ignored filename contains a backslash", () => {
    describe("THEN the matching file is skipped", () => {
      const testBackslashIgnoredPath =
        process.platform === "win32" ? test.skip : test;

      testBackslashIgnoredPath(
        "SHOULD preserve literal backslashes for ignored paths",
        async () => {
          const vaultPath = await mkdtemp(
            path.join(tmpdir(), "vaultgentic-scan-ignored-backslash-"),
          );
          await writeFile(path.join(vaultPath, "a\\b.md"), "# Backslash\n");
          await writeFile(path.join(vaultPath, "keep.md"), "# Keep\n");

          const files = await scanVaultFiles({
            vaultPath,
            ignoredPaths: ["a\\b.md"],
          });

          expect(files.map((file) => file.path)).toEqual(["keep.md"]);
        },
      );
    });
  });

  describe("WHEN an ignored path leaves the vault", () => {
    describe("THEN scanning is rejected", () => {
      test("SHOULD guard traversal paths", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-traversal-"),
        );

        await expect(
          scanVaultFiles({ vaultPath, ignoredPaths: ["../outside"] }),
        ).rejects.toThrow("inside the vault");
      });
    });
  });

  describe("WHEN content hashes are requested", () => {
    describe("THEN SHA-256 hashes are returned", () => {
      test("SHOULD include content_hash only when requested", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-hash-"),
        );
        const content = "# Hash me\n";
        await writeFile(path.join(vaultPath, "note.md"), content);

        const [withoutHash] = await scanVaultFiles({ vaultPath });
        const [withHash] = await scanVaultFiles(
          { vaultPath },
          { includeContentHash: true },
        );

        expect(withoutHash?.content_hash).toBeUndefined();
        expect(withHash?.content_hash).toBe(
          createHash("sha256").update(content).digest("hex"),
        );
      });
    });
  });
});

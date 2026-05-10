import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanVaultFiles, VaultScannerError } from "./scanner.js";

describe("GIVEN vault file scanning", () => {
  describe("WHEN scanning a vault with nested Markdown notes", () => {
    describe("THEN only vault-relative Markdown paths are returned", () => {
      it("SHOULD return sorted Markdown metadata", async () => {
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
      const testBackslashFilename = process.platform === "win32" ? it.skip : it;

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
      it("SHOULD honor exact ignored paths and ignored directories", async () => {
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

      it("SHOULD honor glob patterns for nested directories", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-glob-dir-"),
        );
        await mkdir(path.join(vaultPath, "project", "node_modules"), {
          recursive: true,
        });
        await writeFile(path.join(vaultPath, "keep.md"), "keep");
        await writeFile(
          path.join(vaultPath, "project", "node_modules", "skip.md"),
          "skip",
        );

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["**/node_modules/**"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD skip globbed directory roots before reading descendants", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-glob-root-"),
        );
        await mkdir(path.join(vaultPath, "project", "node_modules"), {
          recursive: true,
        });
        await writeFile(path.join(vaultPath, "keep.md"), "keep");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["**/node_modules/**"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD honor glob patterns for files", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-glob-file-"),
        );
        await mkdir(path.join(vaultPath, "project"), { recursive: true });
        await writeFile(path.join(vaultPath, "keep.md"), "keep");
        await writeFile(path.join(vaultPath, "project", "private.md"), "skip");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["**/private.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD honor brace glob patterns", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-brace-glob-"),
        );
        await writeFile(path.join(vaultPath, "keep.md"), "keep");
        await writeFile(path.join(vaultPath, "alpha.md"), "skip");
        await writeFile(path.join(vaultPath, "beta.md"), "skip");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["{alpha,beta}.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD preserve escaped direct paths with glob syntax characters", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-literal-glob-chars-"),
        );
        await mkdir(path.join(vaultPath, "Project [Archive]"), {
          recursive: true,
        });
        await writeFile(path.join(vaultPath, "keep.md"), "keep");
        await writeFile(
          path.join(vaultPath, "Project [Archive]", "old.md"),
          "skip",
        );

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["Project \\[Archive\\]"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD allow negated patterns to include one ignored file", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-bang-"),
        );
        await writeFile(path.join(vaultPath, "skip.md"), "skip");
        await writeFile(path.join(vaultPath, "keep.md"), "keep");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["*.md", "!keep.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD allow escaped leading exclamation marks in direct paths", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-escaped-bang-"),
        );
        await writeFile(path.join(vaultPath, "!important.md"), "skip");
        await writeFile(path.join(vaultPath, "keep.md"), "keep");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["\\!important.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });

      it("SHOULD allow negated patterns to include one file under an ignored directory", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-negated-child-"),
        );
        await mkdir(path.join(vaultPath, "Docs"), { recursive: true });
        await writeFile(path.join(vaultPath, "Docs", "keep.md"), "keep");
        await writeFile(path.join(vaultPath, "Docs", "skip.md"), "skip");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["Docs/**", "!Docs/keep.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["Docs/keep.md"]);
      });

      it("SHOULD allow negated brace patterns under ignored directories", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-negated-brace-"),
        );
        await mkdir(path.join(vaultPath, "Docs"), { recursive: true });
        await writeFile(path.join(vaultPath, "Docs", "keep.md"), "keep");
        await writeFile(path.join(vaultPath, "Docs", "skip.md"), "skip");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["Docs/**", "!{Docs,Notes}/keep.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["Docs/keep.md"]);
      });

      it("SHOULD NOT allow negated patterns to include default ignored paths", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-default-negated-"),
        );
        await mkdir(path.join(vaultPath, ".git"), { recursive: true });
        await writeFile(path.join(vaultPath, ".git", "keep.md"), "keep");
        await writeFile(path.join(vaultPath, "visible.md"), "visible");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["!.git/keep.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["visible.md"]);
      });

      it("SHOULD NOT read default ignored directories for negated descendants", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-default-pruned-"),
        );
        await mkdir(path.join(vaultPath, "node_modules"), { recursive: true });
        await writeFile(path.join(vaultPath, "visible.md"), "visible");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["!node_modules/keep.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["visible.md"]);
      });

      it("SHOULD treat leading hash marks as path characters", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-ignored-hash-"),
        );
        await writeFile(path.join(vaultPath, "#skip.md"), "skip");
        await writeFile(path.join(vaultPath, "keep.md"), "keep");

        const files = await scanVaultFiles({
          vaultPath,
          ignoredPaths: ["#skip.md"],
        });

        expect(files.map((file) => file.path)).toEqual(["keep.md"]);
      });
    });
  });

  describe("WHEN a POSIX ignored filename contains a backslash", () => {
    describe("THEN the matching file is skipped", () => {
      const testBackslashIgnoredPath =
        process.platform === "win32" ? it.skip : it;

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
      it("SHOULD guard traversal paths", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-traversal-"),
        );

        await expect(
          scanVaultFiles({ vaultPath, ignoredPaths: ["../outside"] }),
        ).rejects.toBeInstanceOf(VaultScannerError);
      });

      it("SHOULD guard traversal glob patterns", async () => {
        const vaultPath = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-scan-glob-traversal-"),
        );

        await expect(
          scanVaultFiles({ vaultPath, ignoredPaths: ["../**/*.md"] }),
        ).rejects.toBeInstanceOf(VaultScannerError);
      });
    });
  });

  describe("WHEN content hashes are requested", () => {
    describe("THEN SHA-256 hashes are returned", () => {
      it("SHOULD include content_hash only when requested", async () => {
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

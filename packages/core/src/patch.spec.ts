import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDatabaseConfig } from "./database.js";
import type { IndexFileResult } from "./indexer.js";
import {
  parseAgentPatchText,
  patchVaultNote,
  VaultPatchError,
} from "./patch.js";

const { indexVaultFileMock } = vi.hoisted(() => ({
  indexVaultFileMock: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  indexVaultFile: indexVaultFileMock,
}));

const agentPatch = (vaultPath: string, lines: string[]): string =>
  [
    "*** Begin Patch",
    `*** Update File: ${vaultPath}`,
    "@@",
    ...lines,
    "*** End Patch",
  ].join("\n");

describe("GIVEN a vault patch service", () => {
  beforeEach(() => {
    indexVaultFileMock.mockReset();
    indexVaultFileMock.mockImplementation(
      async (
        _config: SearchDatabaseConfig,
        vaultRelativePath: string,
      ): Promise<IndexFileResult> => ({
        path: vaultRelativePath,
        status: "indexed",
        chunkCount: 1,
      }),
    );
  });

  describe("WHEN agent patch text is parsed", () => {
    describe("THEN one requested note update is accepted", () => {
      it("SHOULD parse chunks into context removals and additions", () => {
        const result = parseAgentPatchText(
          [
            "*** Begin Patch",
            "*** Update File: notes/alpha.md",
            "@@",
            " Context line.",
            "-Old line.",
            "+New line.",
            "@@",
            "-Second old line.",
            "+Second new line.",
            "*** End Patch",
          ].join("\n"),
          "notes/alpha.md",
        );

        expect(result).toEqual({
          path: "notes/alpha.md",
          chunks: [
            {
              lines: [
                { kind: "context", text: "Context line." },
                { kind: "remove", text: "Old line." },
                { kind: "add", text: "New line." },
              ],
            },
            {
              lines: [
                { kind: "remove", text: "Second old line." },
                { kind: "add", text: "Second new line." },
              ],
            },
          ],
        });
      });

      it("SHOULD parse heredoc-wrapped patch text", () => {
        const result = parseAgentPatchText(
          [
            "cat <<'EOF'",
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
            "EOF",
          ].join("\n"),
          "alpha.md",
        );

        expect(result.path).toBe("alpha.md");
        expect(result.chunks).toHaveLength(1);
      });
    });

    describe("THEN invalid patch shapes are rejected", () => {
      it.each([
        {
          name: "empty patches",
          patch: "   \n",
          error: "Patch must be a non-empty string",
        },
        {
          name: "missing begin marker",
          patch: [
            "*** Update File: alpha.md",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
          error: "Patch must start with *** Begin Patch",
        },
        {
          name: "missing end marker",
          patch: [
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "@@",
            "-old",
            "+new",
          ].join("\n"),
          error: "Patch must end with *** End Patch",
        },
        {
          name: "Add File operations",
          patch: [
            "*** Begin Patch",
            "*** Add File: alpha.md",
            "+new",
            "*** End Patch",
          ].join("\n"),
          error: "Patch must contain exactly one Update File operation",
        },
        {
          name: "multi-operation patches",
          patch: [
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "@@",
            "-old",
            "+new",
            "*** Update File: beta.md",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
          error: "Patch must contain exactly one Update File operation",
        },
        {
          name: "malformed chunks",
          patch: [
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
          error: "expected @@ chunk marker",
        },
      ])("SHOULD reject $name", ({ patch, error }) => {
        expect(() => parseAgentPatchText(patch, "alpha.md")).toThrow(error);
      });

      it("SHOULD reject path mismatches", () => {
        expect(() =>
          parseAgentPatchText(
            [
              "*** Begin Patch",
              "*** Update File: beta.md",
              "@@",
              "-old",
              "+new",
              "*** End Patch",
            ].join("\n"),
            "alpha.md",
          ),
        ).toThrow("Patch headers must match the requested path");
      });
    });
  });

  describe("WHEN an agent patch is applied", () => {
    describe("THEN the existing markdown note is patched safely", () => {
      it("SHOULD return metadata without exposing markdown contents", async () => {
        const config = await createFixture("success");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        const result = await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        expect(result).toEqual({
          path: "alpha.md",
          indexed: true,
        });
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
        expect(result).not.toHaveProperty("content");
      });

      it("SHOULD verify the expected hash before writing", async () => {
        const config = await createFixture("expected-hash");
        const currentMarkdown = "Old note.\n";
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          currentMarkdown,
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          expectedFileHash: hashMarkdown(currentMarkdown),
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });

      it("SHOULD index the note after the patch succeeds", async () => {
        const config = await createFixture("index-after-patch");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");
        indexVaultFileMock.mockImplementationOnce(
          async (
            indexConfig: SearchDatabaseConfig,
            vaultRelativePath: string,
          ): Promise<IndexFileResult> => {
            await expect(
              readFile(
                path.join(indexConfig.vaultPath, vaultRelativePath),
                "utf8",
              ),
            ).resolves.toBe("New note.\n");

            return {
              path: vaultRelativePath,
              status: "indexed",
              chunkCount: 1,
            };
          },
        );

        const result = await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        expect(indexVaultFileMock).toHaveBeenCalledWith(config, "alpha.md");
        expect(result).toEqual({
          path: "alpha.md",
          indexed: true,
        });
      });

      it("SHOULD keep the patched note when indexing fails", async () => {
        const config = await createFixture("index-failure");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");
        const indexError = new Error("database unavailable");
        indexError.stack = "stack trace should stay internal";
        indexVaultFileMock.mockRejectedValueOnce(indexError);

        const result = await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        expect(result).toEqual({
          path: "alpha.md",
          indexed: false,
          warning:
            "Note was patched, but indexing failed. Search results may be stale.",
        });
        expect(result.warning).not.toContain("stack trace");
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });

      it("SHOULD preserve CRLF line endings when the patch matches exactly", async () => {
        const config = await createFixture("crlf");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "one\r\ntwo\r\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-one", "+uno", " two"]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("uno\r\ntwo\r\n");
      });

      it("SHOULD apply patches for notes without final newlines", async () => {
        const config = await createFixture("no-final-newline");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.");

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.");
      });

      it("SHOULD delete all content from a newline-terminated note", async () => {
        const config = await createFixture("delete-all-content");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("");
      });

      it("SHOULD add content to an empty note", async () => {
        const config = await createFixture("empty-note-insertion");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "");

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.");
      });

      it("SHOULD reject insertion-only chunks for non-empty notes", async () => {
        const config = await createFixture("non-empty-insertion-only");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("alpha.md", ["+New note."]),
          }),
        ).rejects.toThrow(
          "Patch insertion-only chunks must include context for non-empty notes",
        );

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Old note.\n");
      });

      it("SHOULD apply a patch where a blank context line is the last array element after split", async () => {
        // The diff library throws "contained invalid line" when an empty string
        // is the last element of split("\n") while still inside an unsatisfied hunk.
        // This happens when the trailing blank context line appears at end of patch.
        const config = await createFixture("trailing-blank-context");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Context line.\nOld line.\n\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", [
            " Context line.",
            "-Old line.",
            "+New line.",
            " ",
          ]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Context line.\nNew line.\n\n");
      });

      it("SHOULD apply a patch with a blank context line emitted as an empty string", async () => {
        const config = await createFixture("blank-context-line");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Line one.\n\nLine three.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", [
            " Line one.",
            " ",
            "-Line three.",
            "+Line three (updated).",
          ]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Line one.\n\nLine three (updated).\n");
      });

      it("SHOULD apply a multi-hunk patch touching separate sections", async () => {
        const config = await createFixture("multi-hunk");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "First line.\nMiddle line.\nLast line.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: [
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "@@",
            "-First line.",
            "+First line (updated).",
            "@@",
            "-Last line.",
            "+Last line (updated).",
            "*** End Patch",
          ].join("\n"),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe(
          "First line (updated).\nMiddle line.\nLast line (updated).\n",
        );
      });

      it("SHOULD apply a multi-hunk patch that includes blank context lines", async () => {
        const config = await createFixture("multi-hunk-blank-context");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "First section.\n\nSecond section.\n\nThird section.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: [
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "@@",
            "-First section.",
            "+First section (updated).",
            " ",
            "@@",
            " ",
            "-Third section.",
            "+Third section (updated).",
            "*** End Patch",
          ].join("\n"),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe(
          "First section (updated).\n\nSecond section.\n\nThird section (updated).\n",
        );
      });

      it("SHOULD apply a multi-hunk patch spanning frontmatter and body", async () => {
        const config = await createFixture("frontmatter-and-body");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "---\ntitle: Old Title\n---\n\nBody text.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: [
            "*** Begin Patch",
            "*** Update File: alpha.md",
            "@@",
            " ---",
            "-title: Old Title",
            "+title: New Title",
            " ---",
            "@@",
            " ",
            "-Body text.",
            "+Updated body text.",
            "*** End Patch",
          ].join("\n"),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("---\ntitle: New Title\n---\n\nUpdated body text.\n");
      });

      it("SHOULD apply a simple agent patch", async () => {
        const config = await createFixture("gnu-timestamps");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });

      it("SHOULD apply hunk headers with section labels and blank context", async () => {
        const config = await createFixture("hunk-section-label");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "# Heading\n\nOld note.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", [
            " # Heading",
            " ",
            "-Old note.",
            "+New note.",
          ]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("# Heading\n\nNew note.\n");
      });

      it("SHOULD apply git-style patch wrappers for paths with spaces", async () => {
        const config = await createFixture("git-wrapper-spaces");
        await writeFile(
          path.join(config.vaultPath, "alpha note.md"),
          "Old note.\n",
        );

        await patchVaultNote(config, {
          path: "alpha note.md",
          patch: agentPatch("alpha note.md", ["-Old note.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha note.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });

      it("SHOULD tolerate trailing whitespace in old lines", async () => {
        const config = await createFixture("trailing-whitespace-tolerance");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Old note.  \n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });

      it("SHOULD tolerate indentation differences in old lines", async () => {
        const config = await createFixture("indentation-tolerance");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "  Old note.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });

      it("SHOULD tolerate Unicode punctuation differences in old lines", async () => {
        const config = await createFixture("unicode-punctuation-tolerance");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Ada’s note — old.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", ["-Ada's note - old.", "+New note."]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("New note.\n");
      });
    });
  });

  describe("WHEN an invalid patch is requested", () => {
    describe("THEN the patch is rejected before writing", () => {
      it("SHOULD reject patches for missing markdown notes", async () => {
        const config = await createFixture("missing-note");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
          }),
        ).rejects.toThrow("Patch path must be an existing markdown file");
      });

      it("SHOULD reject stale hunk context", async () => {
        const config = await createFixture("stale-context");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Different.\n",
        );

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
          }),
        ).rejects.toThrow("Patch old lines were not found");
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Different.\n");
      });

      it("SHOULD reject ambiguous tolerant old-line matches", async () => {
        const config = await createFixture("ambiguous-tolerant-match");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "  Old note.\nOld note.  \n",
        );

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
          }),
        ).rejects.toThrow(
          "Patch old lines matched multiple locations; add context to disambiguate",
        );
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("  Old note.\nOld note.  \n");
      });

      it("SHOULD allow context to disambiguate tolerant old-line matches", async () => {
        const config = await createFixture("disambiguated-tolerant-match");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "First\nOld note.  \nSecond\nOld note.  \n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", [
            " Second",
            "-Old note.",
            "+New note.",
          ]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("First\nOld note.  \nSecond\nNew note.\n");
      });

      it("SHOULD preserve context lines that only match tolerantly", async () => {
        const config = await createFixture("tolerant-context-preserved");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "  Heading  \nOld note.\n",
        );

        await patchVaultNote(config, {
          path: "alpha.md",
          patch: agentPatch("alpha.md", [
            " Heading",
            "-Old note.",
            "+New note.",
          ]),
        });

        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("  Heading  \nNew note.\n");
      });

      it("SHOULD reject malformed patches", async () => {
        const config = await createFixture("malformed");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "@@",
              "-Old note.",
              "+New note.",
              "Extra line.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow(VaultPatchError);
        await expect(
          readFile(path.join(config.vaultPath, "alpha.md"), "utf8"),
        ).resolves.toBe("Old note.\n");
      });

      it("SHOULD reject multiple insertion-only chunks for empty notes", async () => {
        const config = await createFixture("multiple-empty-insertions");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "@@",
              "+First note.",
              "@@",
              "+Second note.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow(
          "Patch insertion-only chunks must target distinct locations",
        );
      });

      it("SHOULD reject malformed hunk headers with line-aware diagnostics", async () => {
        const config = await createFixture("malformed-hunk-header");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "-Old note.",
              "+New note.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("expected @@ chunk marker");
      });

      it("SHOULD reject multi-file patches", async () => {
        const config = await createFixture("multi-file");
        await writeFile(
          path.join(config.vaultPath, "alpha.md"),
          "Old alpha.\n",
        );

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "@@",
              "-Old alpha.",
              "+New alpha.",
              "*** Update File: beta.md",
              "@@",
              "-Old beta.",
              "+New beta.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("Patch must contain exactly one Update");
      });

      it("SHOULD reject create operations", async () => {
        const config = await createFixture("dev-null");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Add File: alpha.md",
              "+New note.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("Patch must contain exactly one Update");
      });

      it("SHOULD reject delete operations", async () => {
        const config = await createFixture("git-create");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Delete File: alpha.md",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("Patch must contain exactly one Update");
      });

      it("SHOULD reject move operations", async () => {
        const config = await createFixture("rename-only");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "*** Move to: beta.md",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("Patch must update one existing markdown file");
      });

      it("SHOULD reject unsupported operations", async () => {
        const config = await createFixture("copy-only");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "*** Copy to: beta.md",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("Unsupported patch operation");
      });

      it("SHOULD reject old unified diff patches", async () => {
        const config = await createFixture("binary-patch");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "diff --git a/alpha.md b/alpha.md",
              "index 1111111..2222222 100644",
              "Binary files a/alpha.md and b/alpha.md differ",
              "",
            ].join("\n"),
          }),
        ).rejects.toThrow("Patch must start with *** Begin Patch");
      });

      it("SHOULD reject malformed chunk lines", async () => {
        const config = await createFixture("combined-merge");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "@@",
              "Old note.",
              "+New note.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("chunk lines must start with space, -, or +");
      });

      it("SHOULD reject wrong requested paths", async () => {
        const config = await createFixture("mismatched-headers");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("beta.md", ["-Old note.", "+New note."]),
          }),
        ).rejects.toThrow("Patch headers must match the requested path");
      });

      it("SHOULD reject no-op patches", async () => {
        const config = await createFixture("no-op");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("alpha.md", ["-Old note.", "+Old note."]),
          }),
        ).rejects.toThrow("Patch must change the markdown note");
      });

      it("SHOULD reject stale expected hashes", async () => {
        const config = await createFixture("stale-hash");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            expectedFileHash: hashMarkdown("Different.\n"),
            patch: agentPatch("alpha.md", ["-Old note.", "+New note."]),
          }),
        ).rejects.toThrow("Expected file hash does not match current note");
        expect(indexVaultFileMock).not.toHaveBeenCalled();
      });

      it("SHOULD reject trailing prose after a patch", async () => {
        const config = await createFixture("trailing-prose");
        await writeFile(path.join(config.vaultPath, "alpha.md"), "Old note.\n");

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: [
              "*** Begin Patch",
              "*** Update File: alpha.md",
              "@@",
              "-Old note.",
              "+New note.",
              "Please apply this change.",
              "*** End Patch",
            ].join("\n"),
          }),
        ).rejects.toThrow("chunk lines must start with space, -, or +");
      });

      it("SHOULD reject symlink notes that escape the vault", async () => {
        const config = await createFixture("symlink-note");
        const outsidePath = path.join(
          path.dirname(config.vaultPath),
          "outside.md",
        );
        await writeFile(outsidePath, "Outside note.\n");
        await symlink(outsidePath, path.join(config.vaultPath, "alpha.md"));

        await expect(
          patchVaultNote(config, {
            path: "alpha.md",
            patch: agentPatch("alpha.md", ["-Outside note.", "+Patched note."]),
          }),
        ).rejects.toThrow("Write path parent must stay inside the vault");
        await expect(readFile(outsidePath, "utf8")).resolves.toBe(
          "Outside note.\n",
        );
      });

      it("SHOULD reject parent symlinks that escape the vault before reading", async () => {
        const config = await createFixture("symlink-parent");
        const outsidePath = path.join(
          path.dirname(config.vaultPath),
          "outside",
        );
        await mkdir(outsidePath);
        await writeFile(path.join(outsidePath, "alpha.md"), "Outside note.\n");
        await symlink(outsidePath, path.join(config.vaultPath, "linked"));

        await expect(
          patchVaultNote(config, {
            path: "linked/alpha.md",
            patch: agentPatch("linked/alpha.md", [
              "-Outside note.",
              "+Patched note.",
            ]),
          }),
        ).rejects.toThrow("Write path parent must stay inside the vault");
        await expect(
          readFile(path.join(outsidePath, "alpha.md"), "utf8"),
        ).resolves.toBe("Outside note.\n");
      });
    });
  });
});

async function createFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `vaultgentic-patch-${name}-`));
  const vaultPath = path.join(root, "vault");
  await mkdir(vaultPath, { recursive: true });

  return {
    vaultPath,
    databasePath: path.join(root, "search.db"),
  };
}

function hashMarkdown(markdown: string): string {
  return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

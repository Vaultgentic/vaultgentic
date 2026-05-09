import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProgram, packageVersion } from "./index.js";

describe("GIVEN the CLI package", () => {
  describe("WHEN creating the Commander program", () => {
    describe("THEN command metadata is configured", () => {
      test("SHOULD use the vaultgentic command name", () => {
        expect(createProgram().name()).toBe("vaultgentic");
      });

      test("SHOULD report the package version", () => {
        expect(createProgram().version()).toBe(packageVersion);
      });

      test("SHOULD include the index status command", () => {
        const indexCommand = createProgram().commands.find(
          (command) => command.name() === "index",
        );

        expect(indexCommand?.commands.map((command) => command.name())).toEqual(
          expect.arrayContaining(["file", "sync", "status"]),
        );
      });

      test("SHOULD include the search command", () => {
        expect(
          createProgram().commands.map((command) => command.name()),
        ).toEqual(expect.arrayContaining(["search"]));
      });
    });
  });
});

describe("GIVEN the index file command", () => {
  describe("WHEN JSON output is requested", () => {
    describe("THEN the requested note is indexed", () => {
      test("SHOULD print the file indexing result", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-cli-file-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          path.join(vaultPath, "alpha.md"),
          "# Alpha\n\nCLI keyword",
        );
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const output: string[] = [];
        const previousLog = console.log;
        console.log = (message?: unknown) => {
          output.push(String(message));
        };

        try {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "file",
              "alpha.md",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        } finally {
          console.log = previousLog;
        }

        expect(JSON.parse(output.join("\n"))).toMatchObject({
          path: "alpha.md",
          status: "indexed",
          chunkCount: 1,
        });
      });
    });
  });
});

describe("GIVEN the index sync command", () => {
  describe("WHEN JSON output is requested", () => {
    describe("THEN changed vault notes are indexed", () => {
      test("SHOULD print sync counts", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "vaultgentic-cli-sync-"));
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          path.join(vaultPath, "alpha.md"),
          "# Alpha\n\nSync keyword",
        );
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const output: string[] = [];
        const previousLog = console.log;
        console.log = (message?: unknown) => {
          output.push(String(message));
        };

        try {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        } finally {
          console.log = previousLog;
        }

        expect(JSON.parse(output.join("\n"))).toMatchObject({
          indexed: 1,
          skipped: 0,
          deleted: 0,
        });
      });
    });
  });
});

describe("GIVEN the index status command", () => {
  describe("WHEN JSON output is requested", () => {
    describe("THEN the configured database is initialized and reported", () => {
      test("SHOULD print database status", async () => {
        const cwd = await mkdtemp(
          path.join(tmpdir(), "vaultgentic-cli-status-"),
        );
        const vaultPath = path.join(cwd, "vault");
        const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
        const configPath = path.join(cwd, "config.json");
        await mkdir(vaultPath);
        await writeFile(
          configPath,
          JSON.stringify({ vaultPath, databasePath }),
        );
        const output: string[] = [];
        const previousLog = console.log;
        console.log = (message?: unknown) => {
          output.push(String(message));
        };

        try {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "status",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        } finally {
          console.log = previousLog;
        }

        expect(JSON.parse(output.join("\n"))).toMatchObject({
          vaultPath,
          databasePath,
          schemaVersion: 1,
          noteCount: 0,
          chunkCount: 0,
          sqlite: {
            ok: true,
            walEnabled: true,
            foreignKeysEnabled: true,
          },
        });
      });
    });
  });
});

describe("GIVEN the search command", () => {
  describe("WHEN keyword mode prints human output", () => {
    describe("THEN compact ranked matches are shown", () => {
      test("SHOULD print title, path, heading, snippet, matched-by, and scores", async () => {
        const { configPath } = await createSearchFixture("human");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "sqlite-vec",
              "--mode",
              "keyword",
              "--config",
              configPath,
              "--scores",
            ],
            { from: "node" },
          );
        });

        expect(output).toContain("1. Alpha");
        expect(output).toContain("Path: alpha.md");
        expect(output).toContain("Heading: Alpha > Details");
        expect(output).toContain("sqlite-vec");
        expect(output).toContain("Matched by: keyword");
        expect(output).toContain("Score:");
      });
    });
  });

  describe("WHEN keyword mode prints JSON output", () => {
    describe("THEN technical search result fields are returned", () => {
      test("SHOULD print keyword search results", async () => {
        const { configPath } = await createSearchFixture("json");
        await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "index",
              "sync",
              "--config",
              configPath,
              "--json",
            ],
            { from: "node" },
          );
        });

        const output = await captureConsoleLog(async () => {
          await createProgram().parseAsync(
            [
              "node",
              "vaultgentic",
              "search",
              "sqlite-vec",
              "--mode",
              "keyword",
              "--config",
              configPath,
              "--limit",
              "1",
              "--json",
            ],
            { from: "node" },
          );
        });

        expect(JSON.parse(output)).toMatchObject([
          {
            rank: 1,
            title: "Alpha",
            path: "alpha.md",
            headingPath: ["Alpha", "Details"],
            matchedBy: ["keyword"],
            chunkIndex: expect.any(Number),
            score: expect.any(Number),
          },
        ]);
      });
    });
  });

  describe("WHEN an unsupported mode is requested", () => {
    describe("THEN a clear invalid-option error is raised", () => {
      test("SHOULD reject non-keyword search modes", async () => {
        const errors: string[] = [];
        const program = createProgram()
          .exitOverride()
          .configureOutput({
            writeErr: (message) => {
              errors.push(message);
            },
          });

        await expect(
          program.parseAsync(
            ["node", "vaultgentic", "search", "sqlite-vec", "--mode", "hybrid"],
            { from: "node" },
          ),
        ).rejects.toThrow("process.exit unexpectedly called");
        expect(errors.join("")).toContain("Unsupported search mode: hybrid");
      });
    });
  });
});

async function createSearchFixture(name: string): Promise<{
  configPath: string;
}> {
  const cwd = await mkdtemp(
    path.join(tmpdir(), `vaultgentic-cli-search-${name}-`),
  );
  const vaultPath = path.join(cwd, "vault");
  const databasePath = path.join(cwd, ".vaultgentic", "index.sqlite");
  const configPath = path.join(cwd, "config.json");
  await mkdir(vaultPath);
  await writeFile(
    path.join(vaultPath, "alpha.md"),
    "---\ntitle: Alpha\n---\n\n# Alpha\n\n## Details\n\nThe sqlite-vec extension is searchable.",
  );
  await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n\nOther content.");
  await writeFile(configPath, JSON.stringify({ vaultPath, databasePath }));

  return { configPath };
}

async function captureConsoleLog(
  callback: () => Promise<void>,
): Promise<string> {
  const output: string[] = [];
  const previousLog = console.log;
  console.log = (message?: unknown) => {
    output.push(String(message));
  };

  try {
    await callback();
  } finally {
    console.log = previousLog;
  }

  return output.join("\n");
}

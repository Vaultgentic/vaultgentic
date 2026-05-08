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

        expect(
          indexCommand?.commands.map((command) => command.name()),
        ).toContain("status");
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

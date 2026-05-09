#!/usr/bin/env node
import { Command } from "commander";
import {
  indexVaultFile,
  initializeSearchDatabase,
  loadConfig,
  syncSearchIndex,
  vaultgenticCoreName,
  type DatabaseStatus,
} from "@vaultgentic/core";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const packageVersion = packageJson.version;

export function createProgram(): Command {
  const program = new Command()
    .name("vaultgentic")
    .description("Local Obsidian search and MCP tooling")
    .version(packageVersion)
    .showHelpAfterError()
    .addHelpText("after", `\nCore package: ${vaultgenticCoreName}`);

  const indexCommand = program
    .command("index")
    .description("Manage the search index");

  indexCommand
    .command("file")
    .argument("<path>", "Vault-relative markdown file path")
    .description("Index or reindex one vault note")
    .option("--config <path>", "Path to config file")
    .option("--json", "Print JSON output")
    .action(
      async (
        filePath: string,
        options: { config?: string; json?: boolean },
      ) => {
        const config = await loadConfig({ configPath: options.config });
        const result = await indexVaultFile(config, filePath);

        if (options.json === true) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(formatIndexFileResult(result));
      },
    );

  indexCommand
    .command("sync")
    .description("Index changed notes and remove deleted notes")
    .option("--config <path>", "Path to config file")
    .option("--json", "Print JSON output")
    .action(async (options: { config?: string; json?: boolean }) => {
      const config = await loadConfig({ configPath: options.config });
      const result = await syncSearchIndex(config);

      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(
        [
          `Indexed: ${result.indexed}`,
          `Skipped: ${result.skipped}`,
          `Deleted: ${result.deleted}`,
        ].join("\n"),
      );
    });

  indexCommand
    .command("status")
    .description("Show database and indexing state")
    .option("--config <path>", "Path to config file")
    .option("--json", "Print JSON output")
    .action(async (options: { config?: string; json?: boolean }) => {
      const config = await loadConfig({ configPath: options.config });
      const status = initializeSearchDatabase(config);

      if (options.json === true) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      console.log(formatStatus(status));
    });

  return program;
}

function formatIndexFileResult(result: {
  path: string;
  status: string;
  chunkCount: number;
}): string {
  return [
    `Path: ${result.path}`,
    `Status: ${result.status}`,
    `Chunks: ${result.chunkCount}`,
  ].join("\n");
}

function formatStatus(status: DatabaseStatus): string {
  return [
    `Vault path: ${status.vaultPath}`,
    `Database path: ${status.databasePath}`,
    `Schema version: ${status.schemaVersion}`,
    `Notes: ${status.noteCount}`,
    `Chunks: ${status.chunkCount}`,
    `SQLite health: ${status.sqlite.ok ? "ok" : "error"}`,
    `WAL enabled: ${status.sqlite.walEnabled ? "yes" : "no"}`,
    `Foreign keys enabled: ${status.sqlite.foreignKeysEnabled ? "yes" : "no"}`,
    `FTS5 available: ${status.sqlite.fts5Available ? "yes" : "no"}`,
    `sqlite-vec available: ${status.sqlite.sqliteVecAvailable ? "yes" : "no"}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createProgram().parse();
}

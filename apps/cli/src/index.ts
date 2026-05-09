#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import {
  indexVaultFile,
  initializeSearchDatabase,
  loadConfig,
  searchBm25,
  syncSearchIndex,
  vaultgenticCoreName,
  type Bm25SearchResult,
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

  program
    .command("search")
    .argument("<query>", "Keyword query text")
    .description("Search indexed vault notes")
    .option("--config <path>", "Path to config file")
    .option("--json", "Print JSON output")
    .option("--mode <mode>", "Search mode", parseSearchMode, "keyword")
    .option("--limit <number>", "Maximum result count", parseSearchLimit)
    .option("--scores", "Show scores in human output")
    .action(
      async (
        query: string,
        options: {
          config?: string;
          json?: boolean;
          mode: "keyword";
          limit?: number;
          scores?: boolean;
        },
      ) => {
        const config = await loadConfig({ configPath: options.config });
        const results = searchBm25(config, { query, limit: options.limit });
        const output = results.map(toKeywordSearchOutput);

        if (options.json === true) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log(
          formatSearchResults(output, { showScores: options.scores }),
        );
      },
    );

  return program;
}

type KeywordSearchOutput = Bm25SearchResult & {
  matchedBy: ["keyword"];
};

function parseSearchMode(mode: string): "keyword" {
  if (mode === "keyword") {
    return mode;
  }

  throw new InvalidArgumentError(`Unsupported search mode: ${mode}`);
}

function parseSearchLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidArgumentError("Search limit must be a positive integer");
  }

  return limit;
}

function toKeywordSearchOutput(result: Bm25SearchResult): KeywordSearchOutput {
  return { ...result, matchedBy: ["keyword"] };
}

function formatSearchResults(
  results: KeywordSearchOutput[],
  options: { showScores?: boolean },
): string {
  if (results.length === 0) {
    return "No results.";
  }

  return results
    .map((result) => formatSearchResult(result, options))
    .join("\n\n");
}

function formatSearchResult(
  result: KeywordSearchOutput,
  options: { showScores?: boolean },
): string {
  const lines = [
    `${result.rank}. ${result.title}`,
    `Path: ${result.path}`,
    ...(result.headingPath.length > 0
      ? [`Heading: ${result.headingPath.join(" > ")}`]
      : []),
    `Snippet: ${result.snippet}`,
    `Matched by: ${result.matchedBy.join(", ")}`,
  ];

  if (options.showScores === true) {
    lines.push(`Score: ${result.score}`);
  }

  return lines.join("\n");
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

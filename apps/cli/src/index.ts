#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import {
  indexVaultFile,
  initializeSearchDatabase,
  loadConfig,
  readVaultTarget,
  rebuildSearchIndex,
  searchBm25,
  searchSemantic,
  searchTitles,
  syncSearchIndex,
  vaultgenticCoreName,
  type Bm25SearchResult,
  type DatabaseStatus,
  type IndexProgressEvent,
  type ReadVaultTargetResult,
  type RebuildSearchIndexResult,
  type SemanticSearchResult,
  type TitleSearchResult,
} from "@vaultgentic/core";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createCliProgress,
  formatCliError,
  isCommanderExit,
  shouldUseColor,
} from "./presentation.js";

type KeywordSearchOutput = Bm25SearchResult & {
  matchedBy: ["keyword"];
};

type SemanticSearchOutput = SemanticSearchResult & {
  matchedBy: ["vector"];
};

type TitleSearchOutput = TitleSearchResult & {
  matchedBy: ["title"];
};

type HybridComponentName = "keyword" | "vector" | "title";

type HybridComponentScore = {
  rank: number;
  score: number;
};

type HybridSearchOutput = (
  | Bm25SearchResult
  | SemanticSearchResult
  | TitleSearchResult
) & {
  matchedBy: HybridComponentName[];
  score: number;
  componentScores: Partial<Record<HybridComponentName, HybridComponentScore>>;
};

type SearchOutput =
  | KeywordSearchOutput
  | SemanticSearchOutput
  | TitleSearchOutput
  | HybridSearchOutput;

type SearchMode = "hybrid" | "keyword" | "semantic" | "title";

type CreateProgramOptions = {
  confirmIndexRebuild?: () => Promise<boolean>;
  progressStream?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
};

const defaultSearchLimit = 10;
const hybridBm25Limit = 40;
const hybridSemanticLimit = 40;
const hybridTitleLimit = 10;
const rrfK = 60;
const hybridWeights: Record<HybridComponentName, number> = {
  keyword: 1,
  vector: 1,
  title: 1.5,
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const packageVersion = packageJson.version;

export function isMainModule(moduleUrl: string, argvPath: string | undefined) {
  if (argvPath === undefined) {
    return false;
  }

  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const confirmIndexRebuild = options.confirmIndexRebuild ?? promptIndexRebuild;
  const progressStream = options.progressStream ?? process.stderr;
  const program = new Command()
    .name("vaultgentic")
    .description("Local Obsidian search and MCP tooling")
    .version(packageVersion)
    .option("--debug", "Print stack traces and error causes")
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
        const result = await runWithIndexProgress(
          {
            enabled: options.json !== true,
            stream: progressStream,
            successMessage: "Indexed file",
            failureMessage: "Indexing failed",
          },
          (onProgress) => indexVaultFile(config, filePath, { onProgress }),
        );

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
      const result = await runWithIndexProgress(
        {
          enabled: options.json !== true,
          stream: progressStream,
          successMessage: "Index sync complete",
          failureMessage: "Index sync failed",
        },
        (onProgress) => syncSearchIndex(config, { onProgress }),
      );

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
    .command("rebuild")
    .description("Destructively rebuild the local search index")
    .option("--config <path>", "Path to config file")
    .option("--json", "Print JSON output")
    .option("--force", "Skip confirmation prompt")
    .action(
      async (options: { config?: string; json?: boolean; force?: boolean }) => {
        if (options.force !== true) {
          const confirmed = await confirmIndexRebuild();
          if (!confirmed) {
            if (options.json === true) {
              console.log(JSON.stringify({ cancelled: true }, null, 2));
              return;
            }

            console.log("Rebuild cancelled.");
            return;
          }
        }

        const config = await loadConfig({ configPath: options.config });
        const result = await runWithIndexProgress(
          {
            enabled: options.json !== true,
            stream: progressStream,
            successMessage: "Index rebuild complete",
            failureMessage: "Index rebuild failed",
          },
          (onProgress) => rebuildSearchIndex(config, { onProgress }),
        );

        if (options.json === true) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(formatRebuildResult(result));
      },
    );

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
    .option("--mode <mode>", "Search mode", parseSearchMode, "hybrid")
    .option("--limit <number>", "Maximum result count", parseSearchLimit)
    .option("--scores", "Show scores in human output")
    .action(
      async (
        query: string,
        options: {
          config?: string;
          json?: boolean;
          mode: SearchMode;
          limit?: number;
          scores?: boolean;
        },
      ) => {
        const config = await loadConfig({ configPath: options.config });
        const output = await search(config, {
          query,
          limit: options.limit,
          mode: options.mode,
        });

        if (options.json === true) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log(
          formatSearchResults(output, { showScores: options.scores }),
        );
      },
    );

  program
    .command("read")
    .argument("<target>", "Vault-relative .md note path or numeric chunk id")
    .description("Read a vault note or indexed chunk")
    .option("--config <path>", "Path to config file")
    .option("--json", "Print JSON output")
    .option("--max-chars <number>", "Maximum content characters", parseMaxChars)
    .option("--with-metadata", "Include indexed note metadata when available")
    .option(
      "--with-note-context",
      "Include indexed note context when available",
    )
    .action(
      async (
        target: string,
        options: {
          config?: string;
          json?: boolean;
          maxChars?: number;
          withMetadata?: boolean;
          withNoteContext?: boolean;
        },
      ) => {
        const config = await loadConfig({ configPath: options.config });
        const result = await readVaultTarget(config, {
          target,
          maxChars: options.maxChars,
          withMetadata: options.withMetadata,
          withNoteContext: options.withNoteContext,
        });

        if (options.json === true) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(formatReadResult(result));
      },
    );

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  io: { stderr: Pick<NodeJS.WriteStream, "isTTY" | "write"> } = {
    stderr: process.stderr,
  },
): Promise<number> {
  const errorOptions = getErrorOptions(argv);
  const commanderErrors: string[] = [];
  const program = createProgram({ progressStream: io.stderr });
  configureErrorHandling(program, commanderErrors);

  try {
    await program.parseAsync(argv, { from: "node" });
    return 0;
  } catch (error) {
    if (isCommanderExit(error) && error.exitCode === 0) {
      return 0;
    }

    io.stderr.write(
      formatCliError(toCliError(error, commanderErrors), {
        color: shouldUseColor(io.stderr),
        debug: errorOptions.debug,
        json: errorOptions.json,
      }),
    );

    if (isCommanderExit(error)) {
      return error.exitCode;
    }

    return 1;
  }
}

function getErrorOptions(argv: string[]): { debug: boolean; json: boolean } {
  const args = argv.slice(2);
  const optionArgs = args.slice(
    0,
    args.indexOf("--") === -1 ? args.length : args.indexOf("--"),
  );

  return {
    debug: optionArgs.includes("--debug"),
    json: optionArgs.includes("--json"),
  };
}

function configureErrorHandling(
  command: Command,
  commanderErrors: string[],
): void {
  command.exitOverride();
  command.configureOutput({
    writeErr: (message) => {
      commanderErrors.push(message);
    },
  });

  for (const childCommand of command.commands) {
    configureErrorHandling(childCommand, commanderErrors);
  }
}

function toCliError(error: unknown, commanderErrors: string[]): unknown {
  const commanderMessage = commanderErrors
    .join("")
    .replace(/^error:\s*/i, "")
    .trim();

  if (commanderMessage !== "") {
    return new InvalidArgumentError(commanderMessage);
  }

  return error;
}

async function runWithIndexProgress<Result>(
  options: {
    enabled: boolean;
    stream: Pick<NodeJS.WriteStream, "isTTY" | "write">;
    successMessage: string;
    failureMessage: string;
  },
  run: (onProgress: (event: IndexProgressEvent) => void) => Promise<Result>,
): Promise<Result> {
  const progress = createCliProgress({
    enabled: options.enabled,
    stream: options.stream,
  });

  try {
    const result = await run(progress.handle);
    progress.succeed(options.successMessage);
    return result;
  } catch (error) {
    progress.fail(options.failureMessage);
    throw error;
  }
}

function parseSearchMode(mode: string): SearchMode {
  if (
    mode === "hybrid" ||
    mode === "keyword" ||
    mode === "semantic" ||
    mode === "title"
  ) {
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

function parseMaxChars(value: string): number {
  const maxChars = Number(value);
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new InvalidArgumentError("Max chars must be a positive integer");
  }

  return maxChars;
}

function toKeywordSearchOutput(result: Bm25SearchResult): KeywordSearchOutput {
  return { ...result, matchedBy: ["keyword"] };
}

function toSemanticSearchOutput(
  result: SemanticSearchResult,
): SemanticSearchOutput {
  return { ...result, matchedBy: ["vector"] };
}

function toTitleSearchOutput(result: TitleSearchResult): TitleSearchOutput {
  return { ...result, matchedBy: ["title"] };
}

async function search(
  config: Parameters<typeof searchBm25>[0],
  options: { query: string; limit?: number; mode: SearchMode },
): Promise<SearchOutput[]> {
  if (options.mode === "hybrid") {
    return searchHybrid(config, options);
  }

  if (options.mode === "title") {
    return searchTitles(config, options).map(toTitleSearchOutput);
  }

  if (options.mode === "semantic") {
    return (await searchSemantic(config, options)).map(toSemanticSearchOutput);
  }

  return searchBm25(config, options).map(toKeywordSearchOutput);
}

async function searchHybrid(
  config: Parameters<typeof searchBm25>[0],
  options: { query: string; limit?: number },
): Promise<HybridSearchOutput[]> {
  const finalLimit = options.limit ?? defaultSearchLimit;
  const keywordLimit = Math.max(hybridBm25Limit, finalLimit);
  const vectorLimit = Math.max(hybridSemanticLimit, finalLimit);
  const titleLimit = Math.max(hybridTitleLimit, finalLimit);
  const [keywordResults, vectorResults, titleResults] = await Promise.all([
    Promise.resolve(
      searchBm25(config, { query: options.query, limit: keywordLimit }),
    ),
    searchSemantic(config, { query: options.query, limit: vectorLimit }),
    Promise.resolve(
      searchTitles(config, { query: options.query, limit: titleLimit }),
    ),
  ]);
  const candidates = new Map<string, HybridSearchOutput>();

  for (const result of keywordResults) {
    addHybridCandidate(candidates, result, "keyword");
  }

  for (const result of vectorResults) {
    addHybridCandidate(candidates, result, "vector");
  }

  for (const result of titleResults) {
    addHybridCandidate(candidates, result, "title");
  }

  return [...candidates.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.rank - right.rank;
    })
    .slice(0, finalLimit)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function addHybridCandidate(
  candidates: Map<string, HybridSearchOutput>,
  result: Bm25SearchResult | SemanticSearchResult | TitleSearchResult,
  componentName: HybridComponentName,
): void {
  const key = result.path;
  const existing = candidates.get(key);
  if (existing !== undefined) {
    addHybridComponent(existing, componentName, result);
    return;
  }

  const candidate: HybridSearchOutput = {
    ...result,
    matchedBy: [],
    score: 0,
    componentScores: {},
  };
  addHybridComponent(candidate, componentName, result);
  candidates.set(key, candidate);
}

function addHybridComponent(
  candidate: HybridSearchOutput,
  componentName: HybridComponentName,
  result: Pick<SearchOutput, "rank" | "score">,
): void {
  const existingComponentScore = candidate.componentScores[componentName];
  if (existingComponentScore !== undefined) {
    if (existingComponentScore.rank <= result.rank) {
      return;
    }

    candidate.score -=
      hybridWeights[componentName] / (rrfK + existingComponentScore.rank);
  }

  if (!candidate.matchedBy.includes(componentName)) {
    candidate.matchedBy.push(componentName);
  }

  candidate.componentScores[componentName] = {
    rank: result.rank,
    score: result.score,
  };
  candidate.score += hybridWeights[componentName] / (rrfK + result.rank);
}

function formatSearchResults(
  results: SearchOutput[],
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
  result: SearchOutput,
  options: { showScores?: boolean },
): string {
  const lines = [
    `${result.rank}. ${result.title}`,
    `Path: ${result.path}`,
    ...("headingPath" in result && result.headingPath.length > 0
      ? [`Heading: ${result.headingPath.join(" > ")}`]
      : []),
    ...("aliases" in result && result.aliases.length > 0
      ? [`Aliases: ${result.aliases.join(", ")}`]
      : []),
    ...("snippet" in result ? [`Snippet: ${result.snippet}`] : []),
    `Matched by: ${result.matchedBy.join(", ")}`,
  ];

  if (options.showScores === true) {
    lines.push(`Score: ${result.score}`);
    if ("componentScores" in result) {
      lines.push(
        `Component scores: ${formatComponentScores(result.componentScores)}`,
      );
    }
  }

  return lines.join("\n");
}

function formatComponentScores(
  componentScores: HybridSearchOutput["componentScores"],
): string {
  return (
    Object.entries(componentScores) as [
      HybridComponentName,
      HybridComponentScore,
    ][]
  )
    .map(
      ([componentName, componentScore]) =>
        `${componentName} rank ${componentScore.rank} score ${componentScore.score}`,
    )
    .join(", ");
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

function formatRebuildResult(result: RebuildSearchIndexResult): string {
  return [
    `Indexed: ${result.indexed}`,
    `Skipped: ${result.skipped}`,
    `Deleted: ${result.deleted}`,
    `Notes: ${result.status.noteCount}`,
    `Chunks: ${result.status.chunkCount}`,
    `Last indexed: ${formatLastIndexedAt(result.status.lastIndexedAt)}`,
  ].join("\n");
}

function formatReadResult(result: ReadVaultTargetResult): string {
  const lines = [result.type === "note" ? result.content : result.text];

  if (result.truncated) {
    lines.push(`\n[truncated from ${result.originalLength} characters]`);
  }

  if (result.type === "note" && result.metadata !== undefined) {
    lines.push("", formatNoteMetadata(result.metadata));
  }

  if (result.type === "chunk" && result.noteContext !== undefined) {
    lines.push("", formatNoteMetadata(result.noteContext));
  }

  return lines.join("\n");
}

function formatNoteMetadata(metadata: {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
}): string {
  return [
    `Path: ${metadata.path}`,
    `Title: ${metadata.title}`,
    ...(metadata.aliases.length > 0
      ? [`Aliases: ${metadata.aliases.join(", ")}`]
      : []),
    ...(metadata.tags.length > 0 ? [`Tags: ${metadata.tags.join(", ")}`] : []),
  ].join("\n");
}

function formatStatus(status: DatabaseStatus): string {
  return [
    `Vault path: ${status.vaultPath}`,
    `Database path: ${status.databasePath}`,
    `Schema version: ${status.schemaVersion}`,
    `Notes: ${status.noteCount}`,
    `Chunks: ${status.chunkCount}`,
    `Last indexed: ${formatLastIndexedAt(status.lastIndexedAt)}`,
    `SQLite health: ${status.sqlite.ok ? "ok" : "error"}`,
    `WAL enabled: ${status.sqlite.walEnabled ? "yes" : "no"}`,
    `Foreign keys enabled: ${status.sqlite.foreignKeysEnabled ? "yes" : "no"}`,
    `FTS5 available: ${status.sqlite.fts5Available ? "yes" : "no"}`,
    `sqlite-vec available: ${status.sqlite.sqliteVecAvailable ? "yes" : "no"}`,
    `Vector storage ready: ${status.vectors.ready ? "yes" : "no"}`,
    `Vector rows: ${status.vectors.chunkEmbeddingCount}`,
    `Embedding model: ${status.vectors.modelId}`,
    `Embedding dimension: ${status.vectors.dimension}`,
  ].join("\n");
}

function formatLastIndexedAt(lastIndexedAt: number | null): string {
  if (lastIndexedAt === null) {
    return "never";
  }

  return new Date(lastIndexedAt).toISOString();
}

async function promptIndexRebuild(): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new Error(
      "Index rebuild confirmation requires an interactive terminal; use --force to rebuild non-interactively",
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await readline.question(
      'This will delete and rebuild the local search index. Type "rebuild" to continue: ',
    );
    return answer.trim() === "rebuild";
  } finally {
    readline.close();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

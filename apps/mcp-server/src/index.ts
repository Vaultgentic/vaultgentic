#!/usr/bin/env node
import {
  initializeSearchDatabase,
  refreshSearchIndex,
  searchVault,
  vaultgenticCoreName,
  type DatabaseStatus,
  type RefreshSearchIndexResult,
  type SearchMode,
  type SearchOutput,
  type SearchDatabaseConfig,
} from "@vaultgentic/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadMcpServerConfig } from "./config.js";

type McpServerConfig = Awaited<ReturnType<typeof loadMcpServerConfig>>;

type VaultgenticMcpServer = {
  config: McpServerConfig;
  databaseStatus: DatabaseStatus;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  server: McpServer;
  search: (input: SearchToolInput) => Promise<SearchToolResponse>;
  toolNames: string[];
};

type CreateVaultgenticMcpServerOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  refreshThrottleMs?: number;
  search?: typeof searchVault;
};

type McpIndexRefreshCoordinator = {
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
};

type CreateMcpIndexRefreshCoordinatorOptions = {
  now?: () => number;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  throttleMs?: number;
};

type SearchToolInput = z.infer<typeof searchToolInputSchema>;

type CompactSearchResult = {
  rank: number;
  path: string;
  title: string;
  chunkId: number | null;
  matchedBy: SearchOutput["matchedBy"];
  headingPath?: string[];
  snippet?: string;
  score?: number;
  componentScores?: Extract<
    SearchOutput,
    { componentScores: unknown }
  >["componentScores"];
};

type SearchToolResponse = {
  query: string;
  mode: SearchMode;
  results: CompactSearchResult[];
  indexStatus: CompactIndexStatus;
  refresh: CompactRefreshSummary;
};

type CompactRefreshSummary = Pick<
  RefreshSearchIndexResult["sync"],
  "indexed" | "skipped" | "deleted"
>;

type CompactIndexStatus = Pick<
  DatabaseStatus,
  "schemaVersion" | "noteCount" | "chunkCount" | "lastIndexedAt"
> & {
  sqlite: Pick<
    DatabaseStatus["sqlite"],
    "ok" | "fts5Available" | "sqliteVecAvailable"
  >;
  vectors: DatabaseStatus["vectors"];
};

const defaultRefreshThrottleMs = 5_000;

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const mcpServerPackageName = "vaultgentic-mcp-server";
export const mcpToolPrefix = "vaultgentic_";
export const plannedMcpToolNames = [
  "vaultgentic_search",
  "vaultgentic_read",
] as const;
export const searchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  mode: z.enum(["hybrid", "semantic", "keyword", "title"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).optional(),
  scope: z.string().trim().min(1).max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  includeScores: z.boolean().optional(),
});
export const readToolInputSchema = z.object({
  target: z.string().trim().min(1),
});
export const forbiddenMcpToolNameParts = [
  "sync",
  "file",
  "rebuild",
  "watch",
  "index",
] as const;
export const sharedCorePackageName = vaultgenticCoreName;
export const packageVersion = packageJson.version;

export function createMcpIndexRefreshCoordinator(
  config: SearchDatabaseConfig,
  options: CreateMcpIndexRefreshCoordinatorOptions = {},
): McpIndexRefreshCoordinator {
  const now = options.now ?? Date.now;
  const refreshIndex = options.refreshIndex ?? refreshSearchIndex;
  const throttleMs = options.throttleMs ?? defaultRefreshThrottleMs;
  let inFlightRefresh: Promise<RefreshSearchIndexResult> | undefined;
  let lastRefreshFinishedAt = 0;

  return {
    async ensureIndexFresh() {
      if (inFlightRefresh !== undefined) {
        return inFlightRefresh;
      }

      if (
        lastRefreshFinishedAt > 0 &&
        now() - lastRefreshFinishedAt < throttleMs
      ) {
        return {
          sync: {
            indexed: 0,
            skipped: 0,
            deleted: 0,
            files: [],
            deletedPaths: [],
          },
          status: initializeSearchDatabase(config),
        };
      }

      inFlightRefresh = refreshIndex(config);
      try {
        const result = await inFlightRefresh;
        lastRefreshFinishedAt = now();
        return result;
      } finally {
        inFlightRefresh = undefined;
      }
    },
  };
}

export function isMainModule(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean {
  if (argvPath === undefined) {
    return false;
  }

  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}

export async function createVaultgenticMcpServer(
  options: CreateVaultgenticMcpServerOptions = {},
): Promise<VaultgenticMcpServer> {
  const config = await loadMcpServerConfig({
    configPath: options.configPath,
    cwd: options.cwd,
    env: options.env,
  });
  initializeSearchDatabase(config);
  const refreshCoordinator = createMcpIndexRefreshCoordinator(config, {
    refreshIndex: options.refreshIndex,
    throttleMs: options.refreshThrottleMs,
  });
  const refreshResult = await refreshCoordinator.ensureIndexFresh();
  const server = new McpServer({
    name: mcpServerPackageName,
    version: packageVersion,
  });
  const search = createSearchToolHandler({
    config,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    search: options.search ?? searchVault,
  });
  server.tool(
    "vaultgentic_search",
    "Search indexed vault notes",
    searchToolInputSchema.shape,
    async (input) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await search(input), null, 2),
        },
      ],
    }),
  );

  return {
    config,
    databaseStatus: refreshResult.status,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    search,
    server,
    toolNames: ["vaultgentic_search"],
  };
}

function createSearchToolHandler(options: {
  config: McpServerConfig;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  search: typeof searchVault;
}): (input: SearchToolInput) => Promise<SearchToolResponse> {
  return async (input) => {
    const parsedInput = searchToolInputSchema.parse(input);
    const refreshResult = await options.ensureIndexFresh();
    const results = await options.search(options.config, {
      query: parsedInput.query,
      limit: parsedInput.limit,
      mode: parsedInput.mode,
      scope: parsedInput.scope,
      tags: parsedInput.tags,
    });

    return {
      query: parsedInput.query,
      mode: parsedInput.mode,
      results: results.map((result) =>
        compactSearchResult(result, parsedInput),
      ),
      indexStatus: compactIndexStatus(refreshResult.status),
      refresh: compactRefreshSummary(refreshResult.sync),
    };
  };
}

function compactRefreshSummary(
  sync: RefreshSearchIndexResult["sync"],
): CompactRefreshSummary {
  return {
    indexed: sync.indexed,
    skipped: sync.skipped,
    deleted: sync.deleted,
  };
}

function compactIndexStatus(status: DatabaseStatus): CompactIndexStatus {
  return {
    schemaVersion: status.schemaVersion,
    noteCount: status.noteCount,
    chunkCount: status.chunkCount,
    lastIndexedAt: status.lastIndexedAt,
    sqlite: {
      ok: status.sqlite.ok,
      fts5Available: status.sqlite.fts5Available,
      sqliteVecAvailable: status.sqlite.sqliteVecAvailable,
    },
    vectors: status.vectors,
  };
}

function compactSearchResult(
  result: SearchOutput,
  input: SearchToolInput,
): CompactSearchResult {
  return {
    rank: result.rank,
    path: result.path,
    title: result.title,
    chunkId: result.chunkId,
    matchedBy: result.matchedBy,
    ...("headingPath" in result ? { headingPath: result.headingPath } : {}),
    ...("snippet" in result ? { snippet: result.snippet } : {}),
    ...(input.includeScores === true ? { score: result.score } : {}),
    ...(input.includeScores === true && "componentScores" in result
      ? { componentScores: result.componentScores }
      : {}),
  };
}

export async function startVaultgenticMcpServer(
  options: CreateVaultgenticMcpServerOptions = {},
): Promise<void> {
  const { server } = await createVaultgenticMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export async function runMcpServerMain(
  options: CreateVaultgenticMcpServerOptions & {
    errorStream?: Pick<NodeJS.WriteStream, "write">;
    exit?: (code: number) => never;
  } = {},
): Promise<void> {
  try {
    await startVaultgenticMcpServer(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorStream = options.errorStream ?? process.stderr;
    errorStream.write(`vaultgentic MCP server failed to start: ${message}\n`);
    const exit = options.exit ?? process.exit;
    exit(1);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runMcpServerMain();
}

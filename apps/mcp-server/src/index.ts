#!/usr/bin/env node
import {
  initializeSearchDatabase,
  readVaultTarget,
  searchVault,
  writeVaultNote,
} from "@vaultgentic/core";
import type {
  DatabaseStatus,
  RefreshSearchIndexResult,
  SearchDatabaseConfig,
} from "@vaultgentic/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadMcpServerConfig } from "./config.js";
import {
  forbiddenMcpToolNameParts,
  mcpToolPrefix,
  plannedMcpToolNames,
  sharedCorePackageName,
  toMcpToolError,
} from "./tools/shared.js";
import {
  createReadToolHandler,
  readToolInputSchema,
  type ReadToolInput,
  type ReadToolResponse,
} from "./tools/read.js";
import {
  createWriteToolHandler,
  writeToolInputSchema,
  type WriteToolInput,
  type WriteToolResponse,
} from "./tools/write.js";
import { createMcpIndexRefreshCoordinator } from "./refresh.js";
import {
  createSearchToolHandler,
  searchToolInputSchema,
  type SearchToolInput,
  type SearchToolResponse,
} from "./tools/search.js";

export {
  createMcpIndexRefreshCoordinator,
  forbiddenMcpToolNameParts,
  mcpToolPrefix,
  plannedMcpToolNames,
  readToolInputSchema,
  searchToolInputSchema,
  sharedCorePackageName,
  writeToolInputSchema,
};

type VaultgenticMcpServer = {
  config: Awaited<ReturnType<typeof loadMcpServerConfig>>;
  databaseStatus: DatabaseStatus;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  read: (input: ReadToolInput) => Promise<ReadToolResponse>;
  server: McpServer;
  search: (input: SearchToolInput) => Promise<SearchToolResponse>;
  toolNames: string[];
  write: (input: WriteToolInput) => Promise<WriteToolResponse>;
};

type CreateVaultgenticMcpServerOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  read?: typeof readVaultTarget;
  refreshThrottleMs?: number;
  search?: typeof searchVault;
  write?: typeof writeVaultNote;
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const mcpServerPackageName = "vaultgentic-mcp-server";
export const packageVersion = packageJson.version;

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
  const read = createReadToolHandler({
    config,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    read: options.read ?? readVaultTarget,
  });
  const write = createWriteToolHandler({
    config,
    write: options.write ?? writeVaultNote,
  });

  server.tool(
    "vaultgentic_search",
    "Search indexed vault notes",
    searchToolInputSchema.shape,
    async (input) => toMcpToolResult(search(input)),
  );
  server.tool(
    "vaultgentic_read",
    "Read a vault note or indexed chunk",
    readToolInputSchema.shape,
    async (input) => toMcpToolResult(read(input)),
  );
  server.tool(
    "vaultgentic_write",
    "Create or update an Obsidian-compatible markdown note.",
    writeToolInputSchema.shape,
    async (input) => toMcpToolResult(write(input)),
  );

  return {
    config,
    databaseStatus: refreshResult.status,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    read,
    search,
    server,
    toolNames: ["vaultgentic_search", "vaultgentic_read", "vaultgentic_write"],
    write,
  };
}

async function toMcpToolResult(result: Promise<unknown>) {
  try {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(await result, null, 2) },
      ],
    };
  } catch (error) {
    const toolError = toMcpToolError(error);
    return {
      isError: true,
      structuredContent: toolError.details,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(toolError.details, null, 2),
        },
      ],
    };
  }
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

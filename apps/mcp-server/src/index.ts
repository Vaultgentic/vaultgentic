#!/usr/bin/env node
import {
  defaultArchiveFolder,
  defaultArchiveOnRemove,
  initializeSearchDatabase,
  patchVaultNote,
  readVaultTarget,
  removeVaultNote,
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
  createPatchToolHandler,
  patchToolInputSchema,
  type PatchToolInput,
  type PatchToolResponse,
} from "./tools/patch.js";
import {
  createRemoveToolHandler,
  removeToolInputSchema,
  type RemoveToolInput,
  type RemoveToolResponse,
} from "./tools/remove.js";
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
  patchToolInputSchema,
  plannedMcpToolNames,
  readToolInputSchema,
  removeToolInputSchema,
  searchToolInputSchema,
  sharedCorePackageName,
  writeToolInputSchema,
};

type VaultgenticMcpServer = {
  config: Awaited<ReturnType<typeof loadMcpServerConfig>>;
  databaseStatus: DatabaseStatus;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  patch: (input: PatchToolInput) => Promise<PatchToolResponse>;
  read: (input: ReadToolInput) => Promise<ReadToolResponse>;
  remove: (input: RemoveToolInput) => Promise<RemoveToolResponse>;
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
  patch?: typeof patchVaultNote;
  read?: typeof readVaultTarget;
  refreshThrottleMs?: number;
  remove?: typeof removeVaultNote;
  search?: typeof searchVault;
  write?: typeof writeVaultNote;
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const mcpServerPackageName = "vaultgentic-mcp-server";
export const packageVersion = packageJson.version;

const searchToolDescription =
  "Search indexed vault notes. Requires a non-empty query. Optional mode is one of hybrid (default), semantic, keyword, or title — title mode matches note titles, paths, and aliases. Use path to restrict results to an exact note path, scope to restrict by directory prefix, tags to filter frontmatter tags, limit 1-100, and includeScores only when ranking details are needed. Hybrid scores use reciprocal-rank fusion (small values, ~0.01-0.025) and are not directly comparable to keyword BM25 scores or title scores; use includeScores with componentScores to compare within a mode. Returns compact JSON with results containing path, title, rank, optional chunk/snippet/heading data, confidence warnings, score metadata when requested, index status, and refresh summary.";

const readToolDescription =
  "Read a vault note by relative path or an indexed chunk by id. Use before patching or overwriting when you need the current content, metadata, or file hash for concurrency checks. Optional maxChars is capped at 200000, includeMetadata adds note metadata such as hash, and includeNoteContext adds surrounding note context for chunk reads. Returns JSON with the requested content plus index status and refresh summary.";

const writeToolDescription =
  "Create or replace an Obsidian-compatible markdown note at a vault-relative path. Requires path and body; optional frontmatter, tags, and aliases are validated and serialized into frontmatter. This is a whole-note write, so read first when preserving existing content matters. The response is metadata-only JSON with path, operation, and indexing status; it does not echo the note body.";

const patchToolDescription =
  "Apply a strict unified diff to an existing vault markdown note. Requires path and patch; include expectedFileHash from a prior read to prevent stale concurrent edits. Read the note first when generating the diff or hash, and retry from fresh content if a conflict or hash mismatch occurs. The response is metadata-only JSON with path and indexing status; it does not echo patch contents.";

function createRemoveToolDescription(
  config: Awaited<ReturnType<typeof loadMcpServerConfig>>,
): string {
  const archiveOnRemove = config.archiveOnRemove ?? defaultArchiveOnRemove;
  const removeBehavior = archiveOnRemove
    ? `Configured to archive removed notes under ${config.archiveFolder ?? defaultArchiveFolder}.`
    : "Configured to permanently delete removed notes.";

  return `Remove an existing Obsidian-compatible markdown note from the vault. Requires path and optional expectedFileHash; strongly prefer reading first and passing the returned hash to prevent stale concurrent deletion. ${removeBehavior} The response is metadata-only JSON with path, operation, archive path when applicable, and index cleanup status; it does not echo note contents.`;
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
  const read = createReadToolHandler({
    config,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    read: options.read ?? readVaultTarget,
  });
  const write = createWriteToolHandler({
    config,
    write: options.write ?? writeVaultNote,
  });
  const patch = createPatchToolHandler({
    config,
    patch: options.patch ?? patchVaultNote,
  });
  const remove = createRemoveToolHandler({
    config,
    remove: options.remove ?? removeVaultNote,
  });

  server.tool(
    "vaultgentic_search",
    searchToolDescription,
    searchToolInputSchema.shape,
    async (input) => toMcpToolResult(search(input)),
  );
  server.tool(
    "vaultgentic_read",
    readToolDescription,
    readToolInputSchema.shape,
    async (input) => toMcpToolResult(read(input)),
  );
  server.tool(
    "vaultgentic_write",
    writeToolDescription,
    writeToolInputSchema.shape,
    async (input) => toMcpToolResult(write(input)),
  );
  server.tool(
    "vaultgentic_patch",
    patchToolDescription,
    patchToolInputSchema.shape,
    async (input) => toMcpToolResult(patch(input)),
  );
  server.tool(
    "vaultgentic_remove",
    createRemoveToolDescription(config),
    removeToolInputSchema.shape,
    async (input) => toMcpToolResult(remove(input)),
  );

  return {
    config,
    databaseStatus: refreshResult.status,
    ensureIndexFresh: refreshCoordinator.ensureIndexFresh,
    patch,
    read,
    remove,
    search,
    server,
    toolNames: [...plannedMcpToolNames],
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

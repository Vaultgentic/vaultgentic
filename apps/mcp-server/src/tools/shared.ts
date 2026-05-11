import { vaultgenticCoreName } from "@vaultgentic/core";
import type {
  DatabaseStatus,
  RefreshSearchIndexResult,
} from "@vaultgentic/core";
import { z } from "zod";

type ExpectedError = Error & {
  expected: boolean;
};

export type McpToolError = Error & {
  code: string;
  expected: boolean;
  details: {
    name: string;
    message: string;
    code: string;
    expected: boolean;
  };
};

export type CompactRefreshSummary = Pick<
  RefreshSearchIndexResult["sync"],
  "indexed" | "skipped" | "deleted"
> & {
  cached?: true;
};

export type CompactIndexStatus = Pick<
  DatabaseStatus,
  "schemaVersion" | "noteCount" | "chunkCount" | "lastIndexedAt"
> & {
  sqlite: Pick<
    DatabaseStatus["sqlite"],
    "ok" | "fts5Available" | "sqliteVecAvailable"
  >;
  vectors: DatabaseStatus["vectors"];
};

export const mcpToolPrefix = "vaultgentic_";
export const plannedMcpToolNames = [
  "vaultgentic_search",
  "vaultgentic_read",
  "vaultgentic_write",
] as const;
export const forbiddenMcpToolNameParts = [
  "sync",
  "file",
  "rebuild",
  "watch",
  "index",
] as const;
export const sharedCorePackageName = vaultgenticCoreName;

export function compactRefreshSummary(
  sync: RefreshSearchIndexResult["sync"],
): CompactRefreshSummary {
  return {
    indexed: sync.indexed,
    skipped: sync.skipped,
    deleted: sync.deleted,
    ...(isCachedRefreshSync(sync) ? { cached: true } : {}),
  };
}

function isCachedRefreshSync(
  sync: RefreshSearchIndexResult["sync"],
): sync is RefreshSearchIndexResult["sync"] & { cached: true } {
  return "cached" in sync && sync.cached === true;
}

export function compactIndexStatus(status: DatabaseStatus): CompactIndexStatus {
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

export function toMcpToolError(error: unknown): McpToolError {
  if (isMcpToolError(error)) {
    return error;
  }

  const details = getMcpErrorDetails(error);
  const toolError = new Error(JSON.stringify(details)) as McpToolError;
  toolError.name = "VaultgenticMcpToolError";
  toolError.code = details.code;
  toolError.expected = details.expected;
  toolError.details = details;
  toolError.cause = error;

  return toolError;
}

function isMcpToolError(error: unknown): error is McpToolError {
  const candidate = error as Partial<McpToolError>;

  return (
    error instanceof Error &&
    typeof candidate.code === "string" &&
    typeof candidate.details === "object" &&
    candidate.details !== null &&
    "code" in candidate.details
  );
}

function getMcpErrorDetails(error: unknown): McpToolError["details"] {
  if (error instanceof z.ZodError) {
    return {
      name: "InvalidMcpToolInput",
      message: z.prettifyError(error),
      code: "invalid_tool_input",
      expected: true,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: classifyError(error.message),
      expected: isExpectedError(error),
    };
  }

  return {
    name: "UnexpectedError",
    message: String(error),
    code: "unexpected_error",
    expected: false,
  };
}

function isExpectedError(error: Error): boolean {
  if ("expected" in error && typeof error.expected === "boolean") {
    return (error as ExpectedError).expected;
  }

  return false;
}

function classifyError(message: string): string {
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes("config")) {
    return "config_error";
  }

  if (
    normalizedMessage.includes("outside the vault") ||
    normalizedMessage.includes("inside the vault") ||
    normalizedMessage.includes("invalid read path") ||
    normalizedMessage.includes("write path")
  ) {
    return "path_rejected";
  }

  if (normalizedMessage.includes("write body")) {
    return "invalid_tool_input";
  }

  if (normalizedMessage.includes("read target")) {
    return "invalid_read_target";
  }

  if (normalizedMessage.includes("fts5")) {
    return "fts_unavailable";
  }

  if (normalizedMessage.includes("sqlite-vec")) {
    return "sqlite_vec_unavailable";
  }

  if (normalizedMessage.includes("embedding")) {
    return "embedding_error";
  }

  if (normalizedMessage.includes("not found")) {
    return "not_found";
  }

  return "vaultgentic_error";
}

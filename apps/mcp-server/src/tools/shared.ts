import { vaultgenticCoreName } from "@vaultgentic/core";
import type {
  DatabaseStatus,
  RefreshSearchIndexResult,
} from "@vaultgentic/core";

export type CompactRefreshSummary = Pick<
  RefreshSearchIndexResult["sync"],
  "indexed" | "skipped" | "deleted"
>;

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
  };
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

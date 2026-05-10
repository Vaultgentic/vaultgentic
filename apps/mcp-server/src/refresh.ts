import {
  initializeSearchDatabase,
  refreshSearchIndex,
} from "@vaultgentic/core";
import type {
  RefreshSearchIndexResult,
  SearchDatabaseConfig,
} from "@vaultgentic/core";

export type McpIndexRefreshCoordinator = {
  ensureIndexFresh: () => Promise<McpRefreshSearchIndexResult>;
};

export type McpRefreshSearchIndexResult = Omit<
  RefreshSearchIndexResult,
  "sync"
> & {
  sync: RefreshSearchIndexResult["sync"] & {
    cached?: true;
  };
};

export type CreateMcpIndexRefreshCoordinatorOptions = {
  now?: () => number;
  refreshIndex?: (
    config: SearchDatabaseConfig,
  ) => Promise<RefreshSearchIndexResult>;
  throttleMs?: number;
};

const defaultRefreshThrottleMs = 5_000;

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
            cached: true,
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

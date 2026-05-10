import type {
  RefreshSearchIndexResult,
  SearchMode,
  SearchOutput,
  searchVault,
} from "@vaultgentic/core";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import {
  compactIndexStatus,
  compactRefreshSummary,
  toMcpToolError,
} from "./shared.js";
import type { CompactIndexStatus, CompactRefreshSummary } from "./shared.js";

export type SearchToolInput = z.infer<typeof searchToolInputSchema>;

export type CompactSearchResult = {
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

export type SearchToolResponse = {
  query: string;
  mode: SearchMode;
  results: CompactSearchResult[];
  indexStatus: CompactIndexStatus;
  refresh: CompactRefreshSummary;
};

export const searchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  mode: z.enum(["hybrid", "semantic", "keyword", "title"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).optional(),
  scope: z.string().trim().min(1).max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  includeScores: z.boolean().optional(),
});

export function createSearchToolHandler(options: {
  config: McpServerConfig;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  search: typeof searchVault;
}): (input: SearchToolInput) => Promise<SearchToolResponse> {
  return async (input) => {
    try {
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
    } catch (error) {
      throw toMcpToolError(error);
    }
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

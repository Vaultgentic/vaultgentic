import type {
  RefreshSearchIndexResult,
  SearchFilterDiagnostics,
  SearchMode,
  SearchOutput,
  searchVault,
} from "@vaultgentic/core";
import { readSearchFilterDiagnostics } from "@vaultgentic/core";
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

export type SearchScoreMetadata = {
  kind: "relevance";
  higherIsBetter: true;
  description: string;
};

export type SearchToolResponse = {
  query: string;
  mode: SearchMode;
  results: CompactSearchResult[];
  confidenceWarnings?: string[];
  filterDiagnostics?: SearchFilterDiagnostics;
  scoreMetadata?: SearchScoreMetadata;
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
  readFilterDiagnostics?: typeof readSearchFilterDiagnostics;
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

      const filterDiagnostics =
        results.length === 0 && hasSearchFilters(parsedInput)
          ? (options.readFilterDiagnostics ?? readSearchFilterDiagnostics)(
              options.config,
              parsedInput,
            )
          : undefined;

      const confidenceWarnings = readConfidenceWarnings(
        parsedInput.mode,
        results,
      );

      return {
        query: parsedInput.query,
        mode: parsedInput.mode,
        results: results.map((result) =>
          compactSearchResult(result, parsedInput),
        ),
        ...(confidenceWarnings.length === 0 ? {} : { confidenceWarnings }),
        ...(filterDiagnostics === undefined ? {} : { filterDiagnostics }),
        ...(parsedInput.includeScores === true
          ? { scoreMetadata: searchScoreMetadata }
          : {}),
        indexStatus: compactIndexStatus(refreshResult.status),
        refresh: compactRefreshSummary(refreshResult.sync),
      };
    } catch (error) {
      throw toMcpToolError(error);
    }
  };
}

function hasSearchFilters(input: SearchToolInput): boolean {
  return (
    input.scope !== undefined ||
    (input.tags !== undefined && input.tags.length > 0)
  );
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
    ...(input.includeScores === true ? { score: toDisplayScore(result) } : {}),
    ...(input.includeScores === true && "componentScores" in result
      ? { componentScores: toDisplayComponentScores(result.componentScores) }
      : {}),
  };
}

const searchScoreMetadata: SearchScoreMetadata = {
  kind: "relevance",
  higherIsBetter: true,
  description:
    "Scores are normalized for MCP responses so higher values indicate better relevance. Keyword BM25 scores are reported as positive relevance, semantic distances are converted to similarity, title scores use title-match relevance, and hybrid scores use weighted reciprocal-rank fusion.",
};

const lowConfidenceSemanticSimilarityThreshold = 0.5;

function readConfidenceWarnings(
  mode: SearchMode,
  results: SearchOutput[],
): string[] {
  if (mode !== "semantic" && mode !== "hybrid") return [];
  if (results.length === 0) return [];

  const topSimilarity = readTopSemanticSimilarity(mode, results);
  if (
    topSimilarity === undefined ||
    topSimilarity >= lowConfidenceSemanticSimilarityThreshold
  ) {
    return [];
  }

  return [
    `Semantic matches are low confidence; top similarity ${topSimilarity.toFixed(2)} is below ${lowConfidenceSemanticSimilarityThreshold.toFixed(2)}. Verify results before treating them as authoritative.`,
  ];
}

function readTopSemanticSimilarity(
  mode: SearchMode,
  results: SearchOutput[],
): number | undefined {
  const [topResult] = results;
  if (topResult === undefined) return undefined;

  if (mode === "semantic") return readVectorSimilarity(topResult);

  const topResultHasNonVectorMatch = topResult.matchedBy.some(
    (match) => match !== "vector",
  );
  if (topResultHasNonVectorMatch) return undefined;

  return readVectorSimilarity(topResult);
}

function readVectorSimilarity(result: SearchOutput): number | undefined {
  if ("componentScores" in result) {
    const vectorScore = result.componentScores.vector;
    return vectorScore === undefined
      ? undefined
      : toSimilarityScore(vectorScore.score);
  }

  return result.matchedBy[0] === "vector"
    ? toSimilarityScore(result.score)
    : undefined;
}

function toDisplayScore(result: SearchOutput): number {
  if ("componentScores" in result) return result.score;

  const [matchedBy] = result.matchedBy;
  if (matchedBy === "keyword") return Math.abs(result.score);
  if (matchedBy === "vector") return toSimilarityScore(result.score);
  return result.score;
}

function toDisplayComponentScores(
  componentScores: Extract<
    SearchOutput,
    { componentScores: unknown }
  >["componentScores"],
): Extract<SearchOutput, { componentScores: unknown }>["componentScores"] {
  return Object.fromEntries(
    Object.entries(componentScores).map(([componentName, componentScore]) => [
      componentName,
      {
        ...componentScore,
        score:
          componentName === "vector"
            ? toSimilarityScore(componentScore.score)
            : Math.abs(componentScore.score),
      },
    ]),
  );
}

function toSimilarityScore(distance: number): number {
  if (!Number.isFinite(distance)) return distance;
  return 1 / (1 + Math.max(0, distance));
}

import {
  searchBm25,
  searchSemantic,
  searchTitles,
  type Bm25SearchResult,
  type SemanticSearchResult,
  type TitleSearchResult,
} from "./indexer.js";
import type { SearchDatabaseConfig } from "./database.js";

export type KeywordSearchOutput = Bm25SearchResult & {
  chunkId: number;
  matchedBy: ["keyword"];
};

export type SemanticSearchOutput = SemanticSearchResult & {
  chunkId: number;
  matchedBy: ["vector"];
};

export type TitleSearchOutput = TitleSearchResult & {
  chunkId: null;
  matchedBy: ["title"];
};

export type HybridComponentName = "keyword" | "vector" | "title";

export type HybridComponentScore = {
  rank: number;
  score: number;
};

export type HybridSearchOutput = Omit<
  Bm25SearchResult | SemanticSearchResult | TitleSearchResult,
  "chunkId"
> & {
  chunkId: number | null;
  matchedBy: HybridComponentName[];
  score: number;
  componentScores: Partial<Record<HybridComponentName, HybridComponentScore>>;
};

export type SearchOutput =
  | KeywordSearchOutput
  | SemanticSearchOutput
  | TitleSearchOutput
  | HybridSearchOutput;

export type SearchMode = "hybrid" | "keyword" | "semantic" | "title";

const hybridBm25Limit = 40;
const hybridSemanticLimit = 40;
const hybridTitleLimit = 10;
const rrfK = 60;
const hybridWeights: Record<HybridComponentName, number> = {
  keyword: 1,
  vector: 1,
  title: 1.5,
};

export async function searchVault(
  config: SearchDatabaseConfig & { searchLimit?: number },
  options: {
    query: string;
    limit?: number;
    mode?: SearchMode;
    scope?: string;
    tags?: string[];
  },
): Promise<SearchOutput[]> {
  const mode = options.mode ?? "hybrid";
  const finalLimit = options.limit ?? config.searchLimit ?? 10;
  const searchOptions = { ...options, limit: finalLimit };

  if (mode === "hybrid") {
    return searchHybrid(config, { ...options, limit: finalLimit });
  }

  if (mode === "title") {
    return filterSearchResults(
      config,
      searchTitles(config, searchOptions).map(toTitleSearchOutput),
      options,
    )
      .slice(0, finalLimit)
      .map(withSearchRank);
  }

  if (mode === "semantic") {
    return filterSearchResults(
      config,
      (await searchSemantic(config, searchOptions)).map(toSemanticSearchOutput),
      options,
    )
      .slice(0, finalLimit)
      .map(withSearchRank);
  }

  return filterSearchResults(
    config,
    searchBm25(config, searchOptions).map(toKeywordSearchOutput),
    options,
  )
    .slice(0, finalLimit)
    .map(withSearchRank);
}

const toKeywordSearchOutput = (
  result: Bm25SearchResult,
): KeywordSearchOutput => {
  return { ...result, matchedBy: ["keyword"] };
};

const toSemanticSearchOutput = (
  result: SemanticSearchResult,
): SemanticSearchOutput => {
  return { ...result, matchedBy: ["vector"] };
};

const toTitleSearchOutput = (result: TitleSearchResult): TitleSearchOutput => {
  return { ...result, chunkId: null, matchedBy: ["title"] };
};

async function searchHybrid(
  config: SearchDatabaseConfig & { searchLimit?: number },
  options: { query: string; limit?: number; scope?: string; tags?: string[] },
): Promise<HybridSearchOutput[]> {
  const finalLimit = options.limit ?? config.searchLimit ?? 5;
  const keywordLimit = Math.max(hybridBm25Limit, finalLimit);
  const vectorLimit = Math.max(hybridSemanticLimit, finalLimit);
  const titleLimit = Math.max(hybridTitleLimit, finalLimit);
  const [keywordResults, vectorResults, titleResults] = await Promise.all([
    Promise.resolve(
      searchBm25(config, {
        query: options.query,
        limit: keywordLimit,
        scope: options.scope,
        tags: options.tags,
      }),
    ),
    searchSemantic(config, {
      query: options.query,
      limit: vectorLimit,
      scope: options.scope,
      tags: options.tags,
    }),
    Promise.resolve(
      searchTitles(config, {
        query: options.query,
        limit: titleLimit,
        scope: options.scope,
        tags: options.tags,
      }),
    ),
  ]);
  const candidates = new Map<string, HybridSearchOutput>();

  for (const result of keywordResults)
    addHybridCandidate(candidates, result, "keyword");
  for (const result of vectorResults)
    addHybridCandidate(candidates, result, "vector");
  for (const result of titleResults)
    addHybridCandidate(candidates, result, "title");

  return filterSearchResults(config, [...candidates.values()], options)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.rank - right.rank;
    })
    .slice(0, finalLimit)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function filterSearchResults<T extends SearchOutput>(
  config: SearchDatabaseConfig,
  results: T[],
  options: { scope?: string; tags?: string[] },
): T[] {
  if (!hasSearchFilters(options)) {
    return results;
  }

  return results.filter((result) => {
    if (options.scope !== undefined && !result.path.startsWith(options.scope)) {
      return false;
    }

    if (options.tags === undefined || options.tags.length === 0) {
      return true;
    }

    return true;
  });
}

function hasSearchFilters(options: {
  scope?: string;
  tags?: string[];
}): boolean {
  return (
    options.scope !== undefined ||
    (options.tags !== undefined && options.tags.length > 0)
  );
}

function withSearchRank<T extends SearchOutput>(result: T, index: number): T {
  return { ...result, rank: index + 1 };
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
    chunkId: "chunkId" in result ? result.chunkId : null,
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
    if (existingComponentScore.rank <= result.rank) return;
    candidate.score -=
      hybridWeights[componentName] / (rrfK + existingComponentScore.rank);
  }

  if (!candidate.matchedBy.includes(componentName))
    candidate.matchedBy.push(componentName);
  candidate.componentScores[componentName] = {
    rank: result.rank,
    score: result.score,
  };
  candidate.score += hybridWeights[componentName] / (rrfK + result.rank);
}

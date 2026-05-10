import type {
  ReadVaultTargetResult,
  readVaultTarget,
  RefreshSearchIndexResult,
} from "@vaultgentic/core";
import { z } from "zod";
import { compactIndexStatus, compactRefreshSummary } from "./shared.js";
import type { CompactIndexStatus, CompactRefreshSummary } from "./shared.js";
import type { McpServerConfig } from "../types.js";

export type ReadToolInput = z.infer<typeof readToolInputSchema>;

export type ReadToolResponse = {
  result: ReadVaultTargetResult;
  indexStatus: CompactIndexStatus;
  refresh: CompactRefreshSummary;
};

export const readToolInputSchema = z.object({
  target: z.union([
    z.string().trim().min(1).max(500),
    z.number().int().positive(),
  ]),
  maxChars: z.number().int().min(1).max(200_000).optional(),
  includeMetadata: z.boolean().optional(),
  includeNoteContext: z.boolean().optional(),
});

const defaultReadMaxChars = 20_000;

export function createReadToolHandler(options: {
  config: McpServerConfig;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  read: typeof readVaultTarget;
}): (input: ReadToolInput) => Promise<ReadToolResponse> {
  return async (input) => {
    const parsedInput = readToolInputSchema.parse(input);
    const refreshResult = await options.ensureIndexFresh();
    const result = await options.read(options.config, {
      target: String(parsedInput.target),
      maxChars: parsedInput.maxChars ?? defaultReadMaxChars,
      withMetadata: parsedInput.includeMetadata,
      withNoteContext: parsedInput.includeNoteContext,
    });

    return {
      result,
      indexStatus: compactIndexStatus(refreshResult.status),
      refresh: compactRefreshSummary(refreshResult.sync),
    };
  };
}

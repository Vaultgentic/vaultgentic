import type {
  ReadVaultTargetResult,
  readVaultTarget,
  RefreshSearchIndexResult,
} from "@vaultgentic/core";
import { z } from "zod";
import {
  compactIndexStatus,
  compactRefreshSummary,
  toMcpToolError,
} from "./shared.js";
import type { CompactIndexStatus, CompactRefreshSummary } from "./shared.js";
import type { McpServerConfig } from "../types.js";

export type ReadToolInput = z.infer<typeof readToolInputSchema>;

export type ReadToolResponse = {
  result: ReadVaultTargetResult;
  indexStatus: CompactIndexStatus;
  refresh: CompactRefreshSummary;
};

export const readToolInputSchema = z.object({
  target: z
    .union([z.string().trim().min(1).max(500), z.number().int().positive()])
    .describe("Vault-relative note path or indexed chunk id."),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(200_000)
    .optional()
    .describe("Maximum characters to return. Defaults to 20000."),
  includeMetadata: z
    .boolean()
    .optional()
    .describe(
      "Include note metadata such as file hash. Required for concurrency-safe patch or overwrite.",
    ),
  includeNoteContext: z
    .boolean()
    .optional()
    .describe("Include surrounding note context when reading a chunk."),
});

const defaultReadMaxChars = 20_000;

export function createReadToolHandler(options: {
  config: McpServerConfig;
  ensureIndexFresh: () => Promise<RefreshSearchIndexResult>;
  read: typeof readVaultTarget;
}): (input: ReadToolInput) => Promise<ReadToolResponse> {
  return async (input) => {
    try {
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
    } catch (error) {
      throw toMcpToolError(error);
    }
  };
}

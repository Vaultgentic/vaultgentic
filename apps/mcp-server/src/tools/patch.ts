import type { patchVaultNote, PatchVaultNoteResult } from "@vaultgentic/core";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import { toMcpToolError } from "./shared.js";

export type PatchToolInput = z.infer<typeof patchToolInputSchema>;

export type PatchToolResponse = {
  result: PatchVaultNoteResult;
};

export const patchToolInputSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Vault-relative path of the note to patch."),
  patch: z
    .string()
    .min(1)
    .max(200_000)
    .refine((patch) => patch.trim().length > 0, {
      message: "patch must be a non-empty string",
    })
    .describe(
      "Vaultgentic agent patch text for one existing markdown note. Use *** Begin Patch, exactly one *** Update File: <path>, one or more @@ chunks with context lines prefixed by space, removals with -, additions with +, then *** End Patch. Add File, Delete File, Move to, multi-operation patches, and path mismatches are unsupported.",
    ),
  expectedFileHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/iu, {
      message: "expectedFileHash must use sha256:<hex>",
    })
    .optional()
    .describe(
      "sha256:<hex> hash from a prior read. Recommended to prevent stale concurrent edits.",
    ),
});

export function createPatchToolHandler(options: {
  config: McpServerConfig;
  patch: typeof patchVaultNote;
}): (input: PatchToolInput) => Promise<PatchToolResponse> {
  return async (input) => {
    try {
      const parsedInput = patchToolInputSchema.parse(input);
      const result = await options.patch(options.config, {
        path: parsedInput.path,
        patch: parsedInput.patch,
        ...(parsedInput.expectedFileHash === undefined
          ? {}
          : { expectedFileHash: parsedInput.expectedFileHash }),
      });

      return { result };
    } catch (error) {
      throw toMcpToolError(error);
    }
  };
}

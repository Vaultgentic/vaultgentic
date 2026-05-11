import type { patchVaultNote, PatchVaultNoteResult } from "@vaultgentic/core";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import { toMcpToolError } from "./shared.js";

export type PatchToolInput = z.infer<typeof patchToolInputSchema>;

export type PatchToolResponse = {
  result: PatchVaultNoteResult;
};

export const patchToolInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
  patch: z
    .string()
    .min(1)
    .max(200_000)
    .refine((patch) => patch.trim().length > 0, {
      message: "patch must be a non-empty string",
    }),
  expectedFileHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/iu, {
      message: "expectedFileHash must use sha256:<hex>",
    })
    .optional(),
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

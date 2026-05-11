import type { removeVaultNote, RemoveVaultNoteResult } from "@vaultgentic/core";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import { toMcpToolError } from "./shared.js";

export type RemoveToolInput = z.infer<typeof removeToolInputSchema>;

export type RemoveToolResponse = {
  result: RemoveVaultNoteResult;
};

export const removeToolInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
  expectedFileHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/iu, {
      message: "expectedFileHash must use sha256:<hex>",
    })
    .optional(),
});

export function createRemoveToolHandler(options: {
  config: McpServerConfig;
  remove: typeof removeVaultNote;
}): (input: RemoveToolInput) => Promise<RemoveToolResponse> {
  return async (input) => {
    try {
      const parsedInput = removeToolInputSchema.parse(input);
      const result = await options.remove(options.config, {
        path: parsedInput.path,
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

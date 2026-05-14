import type { moveVaultNote, MoveVaultNoteResult } from "@vaultgentic/core";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import { toMcpToolError } from "./shared.js";

export type MoveToolInput = z.infer<typeof moveToolInputSchema>;

export type MoveToolResponse = {
  result: MoveVaultNoteResult;
};

export const moveToolInputSchema = z.object({
  fromPath: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Vault-relative path of the note to move or rename."),
  toPath: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Vault-relative destination path for the moved note."),
  expectedFileHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/iu, {
      message: "expectedFileHash must use sha256:<hex>",
    })
    .optional()
    .describe(
      "sha256:<hex> hash from a prior read. Recommended to prevent stale concurrent moves.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Overwrite an existing destination note. Defaults to false; must be true to replace a note.",
    ),
  pruneEmptyParents: z
    .boolean()
    .optional()
    .describe(
      "Prune empty source parent directories after moving. Defaults to true; set false to leave directories in place.",
    ),
});

export function createMoveToolHandler(options: {
  config: McpServerConfig;
  move: typeof moveVaultNote;
}): (input: MoveToolInput) => Promise<MoveToolResponse> {
  return async (input) => {
    try {
      const parsedInput = moveToolInputSchema.parse(input);
      const result = await options.move(options.config, {
        fromPath: parsedInput.fromPath,
        toPath: parsedInput.toPath,
        ...(parsedInput.expectedFileHash === undefined
          ? {}
          : { expectedFileHash: parsedInput.expectedFileHash }),
        ...(parsedInput.overwrite === undefined
          ? {}
          : { overwrite: parsedInput.overwrite }),
        ...(parsedInput.pruneEmptyParents === undefined
          ? {}
          : { pruneEmptyParents: parsedInput.pruneEmptyParents }),
      });

      return { result };
    } catch (error) {
      throw toMcpToolError(error);
    }
  };
}

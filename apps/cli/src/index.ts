#!/usr/bin/env node
import { Command } from "commander";
import { vaultgenticCoreName } from "@vaultgentic/core";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const packageVersion = packageJson.version;

export function createProgram(): Command {
  return new Command()
    .name("vaultgentic")
    .description("Local Obsidian search and MCP tooling")
    .version(packageVersion)
    .showHelpAfterError()
    .addHelpText("after", `\nCore package: ${vaultgenticCoreName}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createProgram().parse();
}

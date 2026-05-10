import type { loadMcpServerConfig } from "./config.js";

export type McpServerConfig = Awaited<ReturnType<typeof loadMcpServerConfig>>;

export interface Config {
  transport: "http" | "stdio";
  port: number;
  engramUrl: string;
  mcpApiKeys: Map<string, string>;
  auditLogLevel: string;
}

let config: Config | null = null;

export function getConfig(): Config {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

function loadConfig(): Config {
  const engramUrl = process.env.ENGRAM_URL;
  if (!engramUrl) {
    throw new Error("Missing required env: ENGRAM_URL");
  }

  // Parse multi-key API authentication: "label1:key1,label2:key2"
  const mcpApiKeys = new Map<string, string>();
  const keysRaw = process.env.MCP_API_KEYS || "";
  if (keysRaw) {
    for (const entry of keysRaw.split(",")) {
      const sep = entry.indexOf(":");
      if (sep > 0) {
        mcpApiKeys.set(
          entry.substring(0, sep).trim(),
          entry.substring(sep + 1).trim(),
        );
      }
    }
  }

  const transport = (process.env.TRANSPORT || "stdio") as "http" | "stdio";

  // HTTP mode requires API keys
  if (transport === "http" && mcpApiKeys.size === 0) {
    throw new Error("HTTP transport requires MCP_API_KEYS to be set");
  }

  return {
    transport,
    port: parseInt(process.env.PORT || "3800", 10),
    engramUrl,
    mcpApiKeys,
    auditLogLevel: process.env.AUDIT_LOG_LEVEL || "info",
  };
}

export function validateConfig(): void {
  const cfg = getConfig();
  console.error(`[Config] Transport: ${cfg.transport}`);
  console.error(`[Config] Engram URL: ${cfg.engramUrl}`);
  if (cfg.transport === "http") {
    console.error(`[Config] Port: ${cfg.port}`);
    console.error(
      `[Config] API Keys: ${[...cfg.mcpApiKeys.keys()].join(", ")}`,
    );
  }
}

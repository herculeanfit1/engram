import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../config.js";
import { audit } from "../utils/audit.js";

// Timing-safe comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against self so total time is constant regardless of length mismatch
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Check all keys in constant time (prevents learning partial matches)
function matchApiKey(provided: string, keys: Map<string, string>): string | null {
  let matched: string | null = null;
  for (const [label, key] of keys) {
    if (timingSafeEqual(provided, key)) {
      matched = label;
    }
  }
  return matched;
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfig();

  const provided = req.headers["x-api-key"];
  if (!provided) {
    audit.accessDenied(req.path, "Missing X-API-Key header", req.ip);
    res.status(401).json({ error: "Unauthorized", message: "Missing X-API-Key header" });
    return;
  }

  const keyValue = Array.isArray(provided) ? provided[0] : provided;
  const label = matchApiKey(keyValue, config.mcpApiKeys);

  if (!label) {
    audit.accessDenied(req.path, "Invalid API key", req.ip);
    res.status(401).json({ error: "Unauthorized", message: "Invalid API key" });
    return;
  }

  (req as unknown as Record<string, unknown>).apiKeyLabel = label;
  next();
}

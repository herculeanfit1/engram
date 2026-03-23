import { getConfig } from './config.js';

export interface ThoughtResult {
  id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CaptureResult {
  status: string;
  id: string;
  created_at: string;
  metadata: Record<string, unknown>;
  processing_time_ms: number;
}

export interface StatsResult {
  total_thoughts: string;
  unique_types: string;
  unique_sources: string;
  oldest: string | null;
  newest: string | null;
}

export interface HealthResult {
  status: string;
  service: string;
  version: string;
  database: string;
}

async function engramFetch(path: string, options?: RequestInit): Promise<Response> {
  const { engramUrl } = getConfig();
  const url = `${engramUrl}${path}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Engram API ${res.status}: ${body}`);
  }
  return res;
}

export async function search(
  query: string,
  limit: number = 10,
  threshold: number = 0.3,
): Promise<{ query: string; count: number; results: ThoughtResult[] }> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    threshold: String(threshold),
  });
  const res = await engramFetch(`/search?${params}`);
  return res.json() as Promise<{ query: string; count: number; results: ThoughtResult[] }>;
}

export async function capture(
  content: string,
  source?: string,
  metadata?: Record<string, unknown>,
): Promise<CaptureResult> {
  const body: Record<string, unknown> = { content };
  if (source) body.source = source;
  if (metadata) body.metadata = metadata;

  const res = await engramFetch('/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<CaptureResult>;
}

export async function stats(): Promise<StatsResult> {
  const res = await engramFetch('/stats');
  return res.json() as Promise<StatsResult>;
}

export async function health(): Promise<HealthResult> {
  const res = await engramFetch('/health');
  return res.json() as Promise<HealthResult>;
}

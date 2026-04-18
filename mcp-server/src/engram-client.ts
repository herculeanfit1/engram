import { getConfig } from "./config.js";

export interface ParentTranscript {
  group_id: string;
  summary: string | null;
  total_chunks: number;
  full_content_available: boolean;
}

export interface ThoughtResult {
  id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
  created_at: string;
  group_id?: string;
  thought_type?: string;
  chunk_index?: number;
  total_chunks?: number;
  summary?: string;
  parent_transcript?: ParentTranscript;
}

export interface CaptureResult {
  status: string;
  id: string;
  created_at: string;
  message: string;
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
  queue_pending?: number;
  embed_model?: string;
}

export interface TranscriptResult {
  group_id: string;
  master: ThoughtResult;
  chunks: ThoughtResult[];
}

export interface QueueResult {
  queue_stats: Array<{ status: string; count: number; latest: string }>;
}

export interface DeleteResult {
  status: string;
  id: string;
  deleted_at: string;
  chunks_deleted: number;
}

export interface RestoreResult {
  status: string;
  id: string;
  chunks_restored: number;
}

export interface UpdateResult {
  id: string;
  metadata: Record<string, unknown>;
  updated_at: string;
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
  filter?: Record<string, unknown>,
  type?: string,
  after?: string,
  before?: string,
  cursor?: string,
): Promise<{
  query: string;
  count: number;
  results: ThoughtResult[];
  next_cursor: string | null;
}> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    threshold: String(threshold),
  });
  if (filter) {
    params.set("filter", JSON.stringify(filter));
  }
  if (type) {
    params.set("type", type);
  }
  if (after) {
    params.set("after", after);
  }
  if (before) {
    params.set("before", before);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  const res = await engramFetch(`/search?${params}`);
  return res.json() as Promise<{
    query: string;
    count: number;
    results: ThoughtResult[];
    next_cursor: string | null;
  }>;
}

export async function capture(
  content: string,
  source?: string,
  metadata?: Record<string, unknown>,
): Promise<CaptureResult> {
  const body: Record<string, unknown> = { content };
  if (source) body.source = source;
  if (metadata) body.metadata = metadata;

  const res = await engramFetch("/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<CaptureResult>;
}

export async function stats(): Promise<StatsResult> {
  const res = await engramFetch("/stats");
  return res.json() as Promise<StatsResult>;
}

export async function health(): Promise<HealthResult> {
  const res = await engramFetch("/health");
  return res.json() as Promise<HealthResult>;
}

export async function transcript(groupId: string): Promise<TranscriptResult> {
  const res = await engramFetch(`/transcript/${groupId}`);
  return res.json() as Promise<TranscriptResult>;
}

export async function queue(): Promise<QueueResult> {
  const res = await engramFetch("/queue");
  return res.json() as Promise<QueueResult>;
}

export async function deleteThought(id: string): Promise<DeleteResult> {
  const res = await engramFetch(`/thoughts/${id}`, { method: "DELETE" });
  return res.json() as Promise<DeleteResult>;
}

export async function restoreThought(id: string): Promise<RestoreResult> {
  const res = await engramFetch(`/thoughts/${id}/restore`, { method: "POST" });
  return res.json() as Promise<RestoreResult>;
}

export async function updateThought(
  id: string,
  metadata: Record<string, unknown>,
): Promise<UpdateResult> {
  const res = await engramFetch(`/thoughts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata }),
  });
  return res.json() as Promise<UpdateResult>;
}

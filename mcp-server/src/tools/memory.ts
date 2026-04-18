import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as engram from "../engram-client.js";
import { audit } from "../utils/audit.js";
import { handleToolError } from "../utils/errors.js";

export function registerMemoryTools(server: McpServer): void {
  // Search semantic memory
  server.tool(
    "engram_search",
    "Search semantic memory for relevant thoughts, facts, preferences, and context. Use this to recall information before answering questions about the user.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.3)
        .describe("Similarity threshold (0.3 recommended, lower = more results)"),
      filter: z
        .record(z.unknown())
        .optional()
        .describe('JSONB metadata filter (e.g. {"type": "decision"}, {"people": ["Alice"]})'),
      type: z
        .string()
        .optional()
        .describe(
          "Filter by thought_type (e.g. 'thought', 'transcript_master'). Prefix with ! to exclude (e.g. '!transcript_chunk')",
        ),
      after: z
        .string()
        .optional()
        .describe("ISO 8601 date — only return thoughts created after this date"),
      before: z
        .string()
        .optional()
        .describe("ISO 8601 date — only return thoughts created before this date"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous search response's next_cursor field"),
    },
    async ({ query, limit, threshold, filter, type, after, before, cursor }) => {
      const t0 = Date.now();
      try {
        const data = await engram.search(
          query,
          limit,
          threshold,
          filter,
          type,
          after,
          before,
          cursor,
        );
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_search", true, elapsed);

        if (data.count === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No memories found for: "${query}"`,
              },
            ],
          };
        }

        const lines = data.results.map((r, i) => {
          const sim = (r.similarity * 100).toFixed(1);
          const meta = r.metadata;
          const type = r.thought_type || (meta?.type as string) || "unknown";
          const topics = Array.isArray(meta?.topics) ? (meta.topics as string[]).join(", ") : "";
          const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : "";

          const parts = [`### ${i + 1}. [${sim}% match] ${type}${date ? ` — ${date}` : ""}`];

          // For chunks, show chunk info and parent summary
          if (r.thought_type === "transcript_chunk") {
            parts.push(`*Chunk ${r.chunk_index}/${r.total_chunks}*`);
            parts.push(r.content);
            if (r.parent_transcript?.summary) {
              parts.push(`\n**Transcript summary:** ${r.parent_transcript.summary}`);
            }
          } else if (r.thought_type === "transcript_master" && r.summary) {
            parts.push(`**Summary:** ${r.summary}`);
            parts.push(`*Full transcript: ${r.total_chunks} chunks, ${r.content.length} chars*`);
          } else {
            parts.push(r.content);
          }

          if (topics) parts.push(`*Topics: ${topics}*`);

          return parts.filter(Boolean).join("\n");
        });

        let text = `Found ${data.count} memories for "${query}":\n\n${lines.join("\n\n---\n\n")}`;
        if (data.next_cursor) {
          text += `\n\n---\n*More results available. Use cursor: \`${data.next_cursor}\`*`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_search", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Capture a thought / memory
  server.tool(
    "engram_capture",
    "Store a thought, fact, preference, decision, or insight into semantic memory. The system will generate an embedding and extract structured metadata (people, topics, type, action items) via LLM.",
    {
      content: z
        .string()
        .min(1)
        .describe(
          "The thought or memory to store. Be descriptive — richer text yields better search results.",
        ),
      source: z
        .string()
        .optional()
        .describe('Source identifier (e.g. "claude-desktop", "conversation", "signal")'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Additional metadata to merge with LLM-extracted metadata"),
    },
    async ({ content, source, metadata }) => {
      const t0 = Date.now();
      try {
        const result = await engram.capture(content, source, metadata);
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_capture", true, elapsed);

        const text = [
          `Memory queued for processing.`,
          `- **ID:** ${result.id}`,
          `- **Status:** ${result.status}`,
          `- **Message:** ${result.message}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_capture", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Get memory stats
  server.tool(
    "engram_stats",
    "Get statistics about stored memories — total count, unique types/sources, and date range.",
    {},
    async () => {
      const t0 = Date.now();
      try {
        const data = await engram.stats();
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_stats", true, elapsed);

        const text = [
          `**Engram Memory Stats**`,
          `- Total thoughts: ${data.total_thoughts}`,
          `- Unique types: ${data.unique_types}`,
          `- Unique sources: ${data.unique_sources}`,
          `- Oldest: ${data.oldest ? new Date(data.oldest).toLocaleString() : "n/a"}`,
          `- Newest: ${data.newest ? new Date(data.newest).toLocaleString() : "n/a"}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_stats", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Health check
  server.tool(
    "engram_health",
    "Check if the Engram memory service and its database are healthy.",
    {},
    async () => {
      const t0 = Date.now();
      try {
        const data = await engram.health();
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_health", true, elapsed);

        const text = [
          `**Engram Health**`,
          `- Status: ${data.status}`,
          `- Database: ${data.database}`,
          `- Version: ${data.version}`,
          `- Queue pending: ${data.queue_pending ?? "n/a"}`,
          `- Embed model: ${data.embed_model ?? "n/a"}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_health", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Retrieve full transcript by group ID
  server.tool(
    "engram_transcript",
    "Retrieve a full transcript and all its chunks by group ID. Use this after search returns a transcript_chunk to get the complete context.",
    {
      group_id: z.string().uuid().describe("The group_id from a search result"),
    },
    async ({ group_id }) => {
      const t0 = Date.now();
      try {
        const data = await engram.transcript(group_id);
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_transcript", true, elapsed);

        const parts = [`## Transcript ${group_id}\n`];
        if (data.master.summary) {
          parts.push(`**Summary:** ${data.master.summary}\n`);
        }
        parts.push(`*${data.chunks.length} chunks, ${data.master.content.length} chars total*\n`);
        for (const chunk of data.chunks) {
          parts.push(`### Chunk ${chunk.chunk_index}/${data.chunks.length}\n${chunk.content}`);
        }

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (error) {
        audit.toolCall("engram_transcript", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Queue status
  server.tool(
    "engram_queue",
    "Check the status of the capture processing queue — how many items are pending, processing, complete, or failed.",
    {},
    async () => {
      const t0 = Date.now();
      try {
        const data = await engram.queue();
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_queue", true, elapsed);

        const lines = data.queue_stats.map(
          (s) => `- **${s.status}**: ${s.count} (latest: ${s.latest || "n/a"})`,
        );
        const text = `**Capture Queue**\n${lines.join("\n") || "Queue is empty."}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_queue", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Soft delete a thought
  server.tool(
    "engram_delete",
    "Delete a thought from semantic memory. If the thought is a transcript master, all its chunks are also deleted. This is a soft delete — the data can be recovered via engram_restore.",
    {
      id: z.string().uuid().describe("The thought ID to delete"),
    },
    async ({ id }) => {
      const t0 = Date.now();
      try {
        const data = await engram.deleteThought(id);
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_delete", true, elapsed);

        const text = [
          `Thought deleted.`,
          `- **ID:** ${data.id}`,
          `- **Deleted at:** ${data.deleted_at}`,
          `- **Chunks deleted:** ${data.chunks_deleted}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_delete", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Restore a soft-deleted thought
  server.tool(
    "engram_restore",
    "Restore a previously deleted thought. If the thought is a transcript master, all its chunks are also restored.",
    {
      id: z.string().uuid().describe("The thought ID to restore"),
    },
    async ({ id }) => {
      const t0 = Date.now();
      try {
        const data = await engram.restoreThought(id);
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_restore", true, elapsed);

        const text = [
          `Thought restored.`,
          `- **ID:** ${data.id}`,
          `- **Chunks restored:** ${data.chunks_restored}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_restore", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );

  // Update thought metadata
  server.tool(
    "engram_update",
    "Update metadata on an existing thought. Merges with existing metadata — unmentioned keys are preserved. Content cannot be changed (capture a new thought instead).",
    {
      id: z.string().uuid().describe("The thought ID to update"),
      metadata: z.record(z.unknown()).describe("Metadata fields to add or overwrite"),
    },
    async ({ id, metadata }) => {
      const t0 = Date.now();
      try {
        const data = await engram.updateThought(id, metadata);
        const elapsed = Date.now() - t0;
        audit.toolCall("engram_update", true, elapsed);

        const text = [
          `Thought metadata updated.`,
          `- **ID:** ${data.id}`,
          `- **Updated at:** ${data.updated_at}`,
          `- **Metadata:** ${JSON.stringify(data.metadata)}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        audit.toolCall("engram_update", false, Date.now() - t0, String(error));
        return handleToolError(error);
      }
    },
  );
}

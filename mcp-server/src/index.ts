import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getConfig, validateConfig } from './config.js';
import { apiKeyAuth } from './middleware/auth.js';
import { registerMemoryTools } from './tools/memory.js';
import { audit } from './utils/audit.js';

function createServer(): McpServer {
  const server = new McpServer({
    name: 'engram-mcp-server',
    version: '1.0.0',
  });
  registerMemoryTools(server);
  return server;
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  audit.serverStart(null, { transport: 'stdio' });
  await server.connect(transport);
}

async function runHTTP(): Promise<void> {
  const config = getConfig();
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    skip: (req) => req.path === '/health',
    handler: (req, res) => {
      audit.rateLimitHit(req.path, req.ip ?? undefined);
      res.status(429).json({ error: 'Rate limit exceeded' });
    },
  });

  const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
  });

  app.use(generalLimiter);
  app.use(express.json());

  // Health — no auth
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'engram-mcp-server', version: '1.0.0' });
  });

  // Auth limiter on MCP endpoint
  app.use('/mcp', authLimiter);
  app.use('/mcp', apiKeyAuth);

  // MCP endpoint — new transport per request
  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(config.port, () => {
    audit.serverStart(config.port, {
      transport: 'http',
      apiKeysConfigured: config.mcpApiKeys.size,
    });
    console.error(`engram-mcp-server listening on http://localhost:${config.port}/mcp`);
  });
}

// Graceful shutdown
function setupShutdown(): void {
  const shutdown = () => {
    console.error('[engram-mcp] Shutting down...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  validateConfig();
  setupShutdown();

  const config = getConfig();
  if (config.transport === 'http') {
    await runHTTP();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

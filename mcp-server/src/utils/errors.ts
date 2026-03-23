// Sanitize sensitive data from error messages
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/Bearer [A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, 'Bearer [REDACTED]')
      .replace(/token=[^&\s]+/g, 'token=[REDACTED]')
      .replace(/password=[^&\s]+/g, 'password=[REDACTED]')
      .replace(/X-API-Key:\s*\S+/gi, 'X-API-Key: [REDACTED]');
  }
  return 'An unexpected error occurred';
}

export function handleToolError(
  error: unknown,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = sanitizeError(error);
  console.error('[MCP Tool Error]', message);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

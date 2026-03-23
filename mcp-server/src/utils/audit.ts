interface AuditEvent {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  eventType: string;
  action: string;
  success: boolean;
  message?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: { message: string };
}

class AuditLogger {
  private serviceName = 'engram-mcp-server';
  private serviceVersion = '1.0.0';

  private log(event: AuditEvent): void {
    const entry = { ...event, service: this.serviceName, version: this.serviceVersion };
    const line = JSON.stringify(entry);
    if (event.level === 'error') {
      console.error(line);
    } else {
      console.error(line);  // stderr to avoid polluting stdio MCP transport
    }
  }

  serverStart(port: number | null, details: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      level: 'info',
      eventType: 'server',
      action: 'startup',
      success: true,
      message: port ? `HTTP server started on port ${port}` : 'Stdio server started',
      details,
    });
  }

  toolCall(toolName: string, success: boolean, durationMs?: number, error?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      level: success ? 'info' : 'error',
      eventType: 'tool_call',
      action: toolName,
      success,
      durationMs,
      error: error ? { message: error } : undefined,
    });
  }

  accessDenied(path: string, reason: string, ip?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      level: 'warn',
      eventType: 'auth',
      action: 'access_denied',
      success: false,
      message: reason,
      details: { path, ip },
    });
  }

  rateLimitHit(path: string, ip?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      level: 'warn',
      eventType: 'rate_limit',
      action: 'blocked',
      success: false,
      details: { path, ip },
    });
  }
}

export const audit = new AuditLogger();

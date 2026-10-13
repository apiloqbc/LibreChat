/**
 * Log levels of a failed `connect()`: a server that rejects the bearer is asking the user to
 * (re)authorize, which is the expected end of an OAuth session and must stay out of error-level
 * logging. Any other failure still logs as an error.
 */
import * as http from 'http';
import * as net from 'net';
import { logger } from '@librechat/data-schemas';
import { MCPConnection } from '~/mcp/connection';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

jest.mock('~/mcp/mcpConfig', () => ({
  mcpConfig: {
    CONNECTION_CHECK_TTL: 0,
    /** Nothing handles the `oauthRequired` event here, so the wait must expire quickly. */
    OAUTH_HANDLING_TIMEOUT: 50,
    TOOLS_LIST_MAX_PAGES: 50,
    TOOLS_LIST_MAX_TOOLS: 1000,
    TOOLS_LIST_MAX_BYTES: 5 * 1024 * 1024,
    TOOLS_LIST_TIMEOUT_MS: 30000,
    CB_BASE_BACKOFF_MS: 1,
    CB_MAX_BACKOFF_MS: 1,
    CB_MAX_FAILED_ROUNDS: 10,
    CB_FAILED_WINDOW_MS: 60000,
    CB_MAX_CYCLES: 10,
    CB_CYCLE_WINDOW_MS: 60000,
    CB_CYCLE_COOLDOWN_MS: 1,
  },
}));

interface StatusServer {
  url: string;
  close: () => Promise<void>;
}

/** Answers every request with the given status, as a server rejecting (or failing) a client would. */
function createStatusServer(status: number): Promise<StatusServer> {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(status === 401 ? 'Unauthorized' : 'Internal Server Error');
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            httpServer.closeAllConnections();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

function loggedMessages(mock: jest.Mock): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

function countMatching(mock: jest.Mock, needle: string): number {
  return loggedMessages(mock).filter((message) => message.includes(needle)).length;
}

describe('MCPConnection connect() failure log levels', () => {
  const serverName = 'auth-log-level-test';
  let server: StatusServer | null;
  let conn: MCPConnection | null;

  beforeEach(() => {
    server = null;
    conn = null;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    MCPConnection.clearCooldown(serverName);
    if (conn) {
      (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
      conn.removeAllListeners();
      await conn.disconnect();
    }
    await server?.close();
  });

  it('logs a rejected bearer (HTTP 401) as a warning, never as an error', async () => {
    server = await createStatusServer(401);
    conn = new MCPConnection({
      serverName,
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow();

    const warnMock = logger.warn as jest.Mock;
    const errorMock = logger.error as jest.Mock;
    expect(countMatching(warnMock, 'OAuth authentication required')).toBe(1);
    expect(countMatching(warnMock, 'OAuth handling failed')).toBe(1);
    expect(countMatching(warnMock, 'Connection failed: authentication required')).toBe(1);
    expect(countMatching(errorMock, 'OAuth handling failed')).toBe(0);
    expect(countMatching(errorMock, 'Connection failed')).toBe(0);
  });

  it('still logs any other failure (HTTP 500) as an error', async () => {
    server = await createStatusServer(500);
    conn = new MCPConnection({
      serverName,
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow();

    const warnMock = logger.warn as jest.Mock;
    const errorMock = logger.error as jest.Mock;
    expect(countMatching(errorMock, 'Connection failed')).toBe(1);
    expect(countMatching(warnMock, 'Connection failed')).toBe(0);
    expect(countMatching(warnMock, 'OAuth authentication required')).toBe(0);
  });
});

/**
 * Verifies GET /status version probing targets the codex engine, not upstream's
 * claude-code (fix for review finding: monitor route still spawned `claude`,
 * queried npm @anthropic-ai/claude-code, and probed /app/node_modules/.bin/claude
 * inside the container image).
 *
 * Coverage:
 *   - admin → response carries `codexVersions` (host/container/latest), and the
 *     legacy `claudeCodeVersions` key is gone
 *   - host probe runs bare `codex --version` (PATH convention shared with
 *     sdk-query.ts / appserver/client.ts)
 *   - latest probe runs `npm view @openai/codex version`
 *   - container probe runs `docker run --rm --entrypoint codex <image> --version`
 *   - no probe references `claude` / @anthropic-ai/claude-code anywhere
 *   - non-admin → no version info in response (and no extra probes fired)
 *
 * child_process is fully mocked (callback style + promisify.custom so
 * `promisify(execFile)` in the route resolves `{ stdout, stderr }`).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  isAdmin: true,
}));

vi.mock('child_process', () => {
  const kCustom = Symbol.for('nodejs.util.promisify.custom');
  function respond(cmd: string, args: string[]): { stdout: string; stderr: string } {
    h.calls.push({ cmd, args });
    let stdout = '';
    if (cmd === 'codex') stdout = 'codex-cli 0.137.0\n';
    else if (cmd === 'npm') stdout = '0.138.0\n';
    else if (cmd === 'docker' && args[0] === 'images') stdout = 'sha256:abc123\n';
    else if (cmd === 'docker' && args[0] === 'run') stdout = 'codex-cli 0.137.0\n';
    return { stdout, stderr: '' };
  }
  const execFile = (cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    const r = respond(cmd, args ?? []);
    callback?.(null, r.stdout, r.stderr);
  };
  (execFile as unknown as Record<symbol, unknown>)[kCustom] = (
    cmd: string,
    args: string[],
  ) => Promise.resolve(respond(cmd, args ?? []));
  const spawn = () => {
    throw new Error('spawn must not be called by GET /status');
  };
  return { execFile, spawn, default: { execFile, spawn } };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: h.isAdmin ? 'admin' : 'member',
      permissions: [],
    });
    return next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/web-context.js', () => ({
  isHostExecutionGroup: () => false,
  hasHostExecutionPermission: () => h.isAdmin,
  canAccessGroup: () => true,
  getWebDeps: () => ({
    queue: {
      getStatus: () => ({
        groups: [
          {
            jid: 'web:monitor-codex-group',
            active: false,
            pendingMessages: false,
            pendingTasks: 0,
            containerName: null,
            displayName: null,
            groupFolder: 'monitor-codex-group',
          },
        ],
        activeContainerCount: 0,
        activeHostProcessCount: 0,
        activeCount: 0,
        waitingCount: 0,
        waitingGroupJids: [],
      }),
    },
  }),
}));

vi.mock('../src/db.js', () => ({
  getAllRegisteredGroups: () => ({}),
  getRegisteredGroup: () => null,
  getRouterState: () => null,
  getUserById: () => null,
  hasContainerModeGroups: () => true,
}));

vi.mock('../src/config.js', () => ({
  CONTAINER_IMAGE: 'happycodex-agent:latest',
}));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 2,
    maxConcurrentHostProcesses: 1,
  }),
}));

const monitorRoutes = (await import('../src/routes/monitor.js')).default;

async function getStatus(): Promise<{ status: number; body: any }> {
  const res = await monitorRoutes.request('/status');
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  h.calls.length = 0;
  h.isAdmin = true;
});

describe('GET /status codex version probes', () => {
  test('admin sees codexVersions probed via codex CLI / @openai/codex', async () => {
    const { status, body } = await getStatus();
    expect(status).toBe(200);

    // Renamed field carries the probe results; legacy key is gone.
    expect(body.codexVersions).toEqual({
      host: 'codex-cli 0.137.0',
      container: 'codex-cli 0.137.0',
      latest: '0.138.0',
    });
    expect('claudeCodeVersions' in body).toBe(false);

    // Host probe: bare `codex --version` (PATH convention).
    expect(h.calls).toContainEqual({ cmd: 'codex', args: ['--version'] });
    // Latest probe: npm view against @openai/codex.
    expect(h.calls).toContainEqual({
      cmd: 'npm',
      args: ['view', '@openai/codex', 'version'],
    });
    // Container probe: codex resolved from the image PATH as entrypoint.
    expect(h.calls).toContainEqual({
      cmd: 'docker',
      args: [
        'run',
        '--rm',
        '--entrypoint',
        'codex',
        'happycodex-agent:latest',
        '--version',
      ],
    });

    // No upstream claude-code probe remains anywhere.
    for (const call of h.calls) {
      expect(call.cmd).not.toBe('claude');
      for (const arg of call.args) {
        expect(arg).not.toContain('@anthropic-ai/claude-code');
        expect(arg).not.toContain('/app/node_modules/.bin/claude');
      }
    }
  });

  test('non-admin gets no version info and no version probes fire', async () => {
    h.isAdmin = false;
    const { status, body } = await getStatus();
    expect(status).toBe(200);
    expect('codexVersions' in body).toBe(false);
    expect('claudeCodeVersions' in body).toBe(false);
    // Only the docker image existence check may run; no codex/npm probes.
    expect(h.calls.filter((c) => c.cmd === 'codex' || c.cmd === 'npm')).toEqual([]);
  });
});

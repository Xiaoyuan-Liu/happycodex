/**
 * mount-security（纯 port，上游无对应测试）—— happycodex 新增最小行为网。
 *
 * 覆盖：路径展开、黑名单模式匹配（含 case-insensitive FS 行为）、allowed root 判定、
 * validateMount 端到端（allowlist 文件经 mock 的 MOUNT_ALLOWLIST_PATH 注入）、
 * 非 main 群组强制只读、容器路径穿越拒绝。
 *
 * 注意：loadMountAllowlist 模块级缓存只在首次成功加载后生效，因此 allowlist 文件
 * 必须在任何 validateMount 调用前写好（beforeAll）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const tmpRoot = fsm.realpathSync(
    fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'hcx-mount-sec-')),
  );
  return {
    ...orig,
    DATA_DIR: pathm.join(tmpRoot, 'data'),
    GROUPS_DIR: pathm.join(tmpRoot, 'data', 'groups'),
    MOUNT_ALLOWLIST_PATH: pathm.join(tmpRoot, 'config', 'mount-allowlist.json'),
  };
});

import { MOUNT_ALLOWLIST_PATH } from '../src/config.js';
import {
  expandPath,
  findAllowedRoot,
  matchesBlockedPattern,
  validateAdditionalMounts,
  validateMount,
} from '../src/mount-security.js';

let allowedRw: string;
let allowedRo: string;

beforeAll(() => {
  const base = path.dirname(path.dirname(MOUNT_ALLOWLIST_PATH));
  allowedRw = path.join(base, 'projects');
  allowedRo = path.join(base, 'docs');
  fs.mkdirSync(path.join(allowedRw, 'repo-a'), { recursive: true });
  fs.mkdirSync(path.join(allowedRw, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(allowedRo, 'manuals'), { recursive: true });
  fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
  fs.writeFileSync(
    MOUNT_ALLOWLIST_PATH,
    JSON.stringify({
      allowedRoots: [
        { path: allowedRw, allowReadWrite: true, description: 'rw root' },
        { path: allowedRo, allowReadWrite: false, description: 'ro root' },
      ],
      blockedPatterns: ['customsecret'],
      nonMainReadOnly: true,
    }),
  );
});

describe('expandPath', () => {
  test('~ 与 ~/ 展开为 home；其余 resolve 为绝对路径', () => {
    expect(expandPath('~')).toBe(os.homedir());
    expect(expandPath('~/x/y')).toBe(path.join(os.homedir(), 'x', 'y'));
    expect(path.isAbsolute(expandPath('rel/dir'))).toBe(true);
  });
});

describe('matchesBlockedPattern', () => {
  test('路径段精确命中默认黑名单（.ssh / credentials 等）', () => {
    expect(matchesBlockedPattern('/home/u/.ssh/keys', ['.ssh'])).toBe('.ssh');
    expect(matchesBlockedPattern('/srv/credentials/x', ['credentials'])).toBe('credentials');
    expect(matchesBlockedPattern('/srv/safe/x', ['.ssh'])).toBeNull();
  });

  test('子串不算命中（必须整段相等）', () => {
    expect(matchesBlockedPattern('/home/u/sshd-config/x', ['.ssh'])).toBeNull();
  });

  test('darwin/win32 上大小写不敏感（~/.SSH 不能绕过 .ssh 黑名单）', () => {
    const hit = matchesBlockedPattern('/home/u/.SSH/keys', ['.ssh']);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(hit).toBe('.ssh');
    } else {
      expect(hit).toBeNull();
    }
  });
});

describe('findAllowedRoot', () => {
  test('root 内命中，root 外/不存在的 root 跳过', () => {
    const roots = [
      { path: allowedRw, allowReadWrite: true },
      { path: '/definitely/not/exist', allowReadWrite: true },
    ];
    expect(findAllowedRoot(path.join(allowedRw, 'repo-a'), roots)?.path).toBe(allowedRw);
    expect(findAllowedRoot('/tmp', roots)).toBeNull();
  });
});

describe('validateMount（allowlist 端到端）', () => {
  test('rw root 下的读写请求：main 允许读写', () => {
    const r = validateMount(
      { hostPath: path.join(allowedRw, 'repo-a'), readonly: false },
      true,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(false);
    expect(r.resolvedContainerPath).toBe('repo-a');
  });

  test('nonMainReadOnly：非 main 群组强制只读', () => {
    const r = validateMount(
      { hostPath: path.join(allowedRw, 'repo-a'), readonly: false },
      false,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(true);
  });

  test('ro root：allowReadWrite=false 强制只读', () => {
    const r = validateMount(
      { hostPath: path.join(allowedRo, 'manuals'), readonly: false },
      true,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(true);
  });

  test('黑名单段（.ssh，默认模式与自定义合并）拒绝', () => {
    const r = validateMount({ hostPath: path.join(allowedRw, '.ssh') }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/blocked pattern/);
  });

  test('allowed roots 之外拒绝；不存在的 hostPath 拒绝', () => {
    expect(validateMount({ hostPath: os.tmpdir() }, true).allowed).toBe(false);
    expect(
      validateMount({ hostPath: path.join(allowedRw, 'missing-sub') }, true).allowed,
    ).toBe(false);
  });

  test('containerPath 穿越/绝对路径/空 拒绝', () => {
    const host = path.join(allowedRw, 'repo-a');
    expect(validateMount({ hostPath: host, containerPath: '../up' }, true).allowed).toBe(false);
    expect(validateMount({ hostPath: host, containerPath: '/abs' }, true).allowed).toBe(false);
    expect(validateMount({ hostPath: host, containerPath: '  ' }, true).allowed).toBe(false);
  });
});

describe('validateAdditionalMounts', () => {
  test('混合输入：仅合法挂载存活，containerPath 前缀 /workspace/extra/', () => {
    const validated = validateAdditionalMounts(
      [
        { hostPath: path.join(allowedRw, 'repo-a'), readonly: false },
        { hostPath: path.join(allowedRw, '.ssh') },
        { hostPath: '/outside/root' },
      ],
      'Test Group',
      true,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      hostPath: path.join(allowedRw, 'repo-a'),
      containerPath: '/workspace/extra/repo-a',
      readonly: false,
    });
  });
});

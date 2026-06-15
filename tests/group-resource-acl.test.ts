/**
 * tests/group-resource-acl.test.ts —— issue #2 P1/P2：资源级 ACL（canControlGroupResource）。
 *
 * 终端 WS（web.ts terminal_start）此前只查 canAccessGroup（访问级），共享成员即可在 owner 的
 * 容器里开交互 shell 并抢占 owner 的终端——比 stop/interrupt 更强却守得更松。修复后终端、
 * /stop、/interrupt 三者统一走 canControlGroupResource（owner 或当前运行发起者）。本测试覆盖
 * 该共享规则的判定矩阵：
 *   - owner（canModifyGroup）                    → 允许（与发起者无关）
 *   - 共享成员、自己是当前运行发起者              → 允许
 *   - 共享成员、owner 是发起者                    → 拒绝
 *   - 共享成员、无活跃发起者                      → 拒绝
 */
import { describe, expect, test } from 'vitest';

import { canControlGroupResource } from '../src/web-context.js';
import type { RegisteredGroup, UserRole } from '../src/types.js';

const OWNER = 'owner-1';
const MEMBER = 'member-2';

/** 一个由 OWNER 创建的 web 工作区（canModifyGroup 对 web 群即 created_by===user.id）。 */
function webGroup(): RegisteredGroup & { jid: string } {
  return {
    name: 'shared ws',
    folder: 'home-owner-1',
    added_at: '2026-01-01T00:00:00.000Z',
    created_by: OWNER,
    is_home: false,
    jid: 'web:home-owner-1',
  };
}

function u(id: string, role: UserRole = 'member'): { id: string; role: UserRole } {
  return { id, role };
}

describe('canControlGroupResource — 资源级 ACL 判定矩阵（issue #2）', () => {
  test('owner → 允许（无论是否有发起者）', () => {
    expect(canControlGroupResource(u(OWNER), webGroup(), null)).toBe(true);
    expect(canControlGroupResource(u(OWNER), webGroup(), MEMBER)).toBe(true);
  });

  test('共享成员、自己是当前运行发起者 → 允许', () => {
    expect(canControlGroupResource(u(MEMBER), webGroup(), MEMBER)).toBe(true);
  });

  test('共享成员、owner 是发起者 → 拒绝', () => {
    expect(canControlGroupResource(u(MEMBER), webGroup(), OWNER)).toBe(false);
  });

  test('共享成员、无活跃发起者 → 拒绝', () => {
    expect(canControlGroupResource(u(MEMBER), webGroup(), null)).toBe(false);
  });

  test('admin 角色不绕过：非 owner 且非发起者的 admin 仍被拒绝（与 stop/interrupt 同口径）', () => {
    expect(canControlGroupResource(u('admin-x', 'admin'), webGroup(), null)).toBe(false);
  });
});

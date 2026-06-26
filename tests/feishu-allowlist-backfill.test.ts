import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-allowlist-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  setRegisteredGroup,
  getRegisteredGroup,
  deleteRegisteredGroup,
  findEmptyAllowlistFeishuGroupsForUser,
  backfillEmptyAllowlistsForUser,
  backfillMissingFeishuOwnersForUser,
  clearSenderAllowlist,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const USER_A = 'user-a';
const USER_B = 'user-b';
const OWNER_A = 'ou_aaaaaaaaaaaaaaaaaaaaaa';
const OWNER_B = 'ou_bbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  // Wipe registered_groups via the public delete API for any jids the tests touch
  for (const jid of [
    'feishu:locked-1',
    'feishu:locked-2',
    'feishu:already-set',
    'feishu:missing-owner',
    'feishu:missing-owner-other-allowed',
    'feishu:has-owner',
    'feishu:unrestricted',
    'feishu:other-user-locked',
    'telegram:also-locked',
    'wechat:also-locked',
  ]) {
    deleteRegisteredGroup(jid);
  }
});

function makeGroup(
  jid: string,
  userId: string,
  allowlist: string[] | null | undefined,
  ownerImId?: string,
) {
  setRegisteredGroup(jid, {
    name: jid,
    folder: `home-${userId}`,
    added_at: new Date().toISOString(),
    created_by: userId,
    sender_allowlist: allowlist,
    owner_im_id: ownerImId,
  });
}

describe('findEmptyAllowlistFeishuGroupsForUser', () => {
  test('returns empty array when user has no Feishu groups', () => {
    expect(findEmptyAllowlistFeishuGroupsForUser(USER_A)).toEqual([]);
  });

  test('returns only groups with sender_allowlist=[]', () => {
    makeGroup('feishu:locked-1', USER_A, []);
    makeGroup('feishu:locked-2', USER_A, []);
    makeGroup('feishu:already-set', USER_A, [OWNER_A]);
    makeGroup('feishu:unrestricted', USER_A, null);

    const result = findEmptyAllowlistFeishuGroupsForUser(USER_A);
    expect(result.sort()).toEqual(['feishu:locked-1', 'feishu:locked-2']);
  });

  test('does not include other users\' locked groups', () => {
    makeGroup('feishu:locked-1', USER_A, []);
    makeGroup('feishu:other-user-locked', USER_B, []);

    expect(findEmptyAllowlistFeishuGroupsForUser(USER_A)).toEqual([
      'feishu:locked-1',
    ]);
    expect(findEmptyAllowlistFeishuGroupsForUser(USER_B)).toEqual([
      'feishu:other-user-locked',
    ]);
  });

  test('does not include non-Feishu channels even if locked', () => {
    makeGroup('feishu:locked-1', USER_A, []);
    makeGroup('telegram:also-locked', USER_A, []);
    makeGroup('wechat:also-locked', USER_A, []);

    expect(findEmptyAllowlistFeishuGroupsForUser(USER_A)).toEqual([
      'feishu:locked-1',
    ]);
  });
});

describe('backfillEmptyAllowlistsForUser', () => {
  test('updates locked groups to [ownerOpenId] and returns their jids', () => {
    makeGroup('feishu:locked-1', USER_A, []);
    makeGroup('feishu:locked-2', USER_A, []);

    const result = backfillEmptyAllowlistsForUser(USER_A, OWNER_A);

    expect(result.sort()).toEqual(['feishu:locked-1', 'feishu:locked-2']);
    expect(getRegisteredGroup('feishu:locked-1')?.sender_allowlist).toEqual([
      OWNER_A,
    ]);
    expect(getRegisteredGroup('feishu:locked-2')?.sender_allowlist).toEqual([
      OWNER_A,
    ]);
  });

  test('does not touch groups with non-empty allowlist', () => {
    makeGroup('feishu:already-set', USER_A, [OWNER_A]);
    makeGroup('feishu:unrestricted', USER_A, null);

    const result = backfillEmptyAllowlistsForUser(USER_A, 'ou_new');
    expect(result).toEqual([]);
    expect(getRegisteredGroup('feishu:already-set')?.sender_allowlist).toEqual([
      OWNER_A,
    ]);
    expect(getRegisteredGroup('feishu:unrestricted')?.sender_allowlist).toBeUndefined();
  });

  test('does not affect another user\'s locked groups', () => {
    makeGroup('feishu:locked-1', USER_A, []);
    makeGroup('feishu:other-user-locked', USER_B, []);

    backfillEmptyAllowlistsForUser(USER_A, OWNER_A);

    expect(getRegisteredGroup('feishu:locked-1')?.sender_allowlist).toEqual([
      OWNER_A,
    ]);
    // USER_B's group still locked
    expect(getRegisteredGroup('feishu:other-user-locked')?.sender_allowlist).toEqual([]);
  });

  test('returns empty array when nothing needs backfill', () => {
    expect(backfillEmptyAllowlistsForUser(USER_A, OWNER_A)).toEqual([]);
  });

  test('is idempotent: calling twice with same owner is a no-op the second time', () => {
    makeGroup('feishu:locked-1', USER_A, []);

    const first = backfillEmptyAllowlistsForUser(USER_A, OWNER_A);
    const second = backfillEmptyAllowlistsForUser(USER_A, OWNER_B);

    expect(first).toEqual(['feishu:locked-1']);
    expect(second).toEqual([]); // no longer empty array, so not picked up
    expect(getRegisteredGroup('feishu:locked-1')?.sender_allowlist).toEqual([
      OWNER_A,
    ]);
  });
});

describe('backfillMissingFeishuOwnersForUser', () => {
  test('sets owner_im_id when an existing Feishu allowlist already contains ownerOpenId', () => {
    makeGroup('feishu:missing-owner', USER_A, [OWNER_A]);

    const result = backfillMissingFeishuOwnersForUser(USER_A, OWNER_A);

    expect(result).toEqual(['feishu:missing-owner']);
    expect(getRegisteredGroup('feishu:missing-owner')?.owner_im_id).toBe(OWNER_A);
  });

  test('does not touch unrestricted groups, other users, other channels, or already-owned groups', () => {
    makeGroup('feishu:unrestricted', USER_A, null);
    makeGroup('feishu:other-user-locked', USER_B, [OWNER_A]);
    makeGroup('telegram:also-locked', USER_A, [OWNER_A]);
    makeGroup('feishu:has-owner', USER_A, [OWNER_A], OWNER_B);

    expect(backfillMissingFeishuOwnersForUser(USER_A, OWNER_A)).toEqual([]);
    expect(getRegisteredGroup('feishu:unrestricted')?.owner_im_id).toBeUndefined();
    expect(getRegisteredGroup('feishu:other-user-locked')?.owner_im_id).toBeUndefined();
    expect(getRegisteredGroup('telegram:also-locked')?.owner_im_id).toBeUndefined();
    expect(getRegisteredGroup('feishu:has-owner')?.owner_im_id).toBe(OWNER_B);
  });

  test('does not claim when allowlist does not contain ownerOpenId', () => {
    makeGroup('feishu:missing-owner-other-allowed', USER_A, [OWNER_B]);

    expect(backfillMissingFeishuOwnersForUser(USER_A, OWNER_A)).toEqual([]);
    expect(getRegisteredGroup('feishu:missing-owner-other-allowed')?.owner_im_id).toBeUndefined();
  });
});

describe('clearSenderAllowlist', () => {
  test('sets sender_allowlist to null/undefined (unrestricted)', () => {
    makeGroup('feishu:locked-1', USER_A, []);
    expect(getRegisteredGroup('feishu:locked-1')?.sender_allowlist).toEqual([]);

    clearSenderAllowlist('feishu:locked-1');

    // parseGroupRow converts SQL NULL → undefined
    expect(getRegisteredGroup('feishu:locked-1')?.sender_allowlist).toBeUndefined();
  });

  test('clears even a populated allowlist', () => {
    makeGroup('feishu:already-set', USER_A, [OWNER_A, OWNER_B]);

    clearSenderAllowlist('feishu:already-set');

    expect(getRegisteredGroup('feishu:already-set')?.sender_allowlist).toBeUndefined();
  });

  test('is a no-op for non-existent jid', () => {
    expect(() => clearSenderAllowlist('feishu:does-not-exist')).not.toThrow();
  });
});

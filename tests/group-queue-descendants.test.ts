import { describe, expect, test } from 'vitest';
import { GroupQueue } from '../src/group-queue.js';

// Seed a GroupQueue's internal map directly. The class is fine with this
// because listActiveDescendantJids only reads state.active + iterates entries;
// the rest of GroupState is irrelevant here.
function seedActive(q: GroupQueue, jids: string[]) {
  const anyQ = q as unknown as { groups: Map<string, { active: boolean }> };
  for (const jid of jids) {
    anyQ.groups.set(jid, { active: true });
  }
}

function seedIdle(q: GroupQueue, jids: string[]) {
  const anyQ = q as unknown as { groups: Map<string, { active: boolean }> };
  for (const jid of jids) {
    anyQ.groups.set(jid, { active: false });
  }
}

// Mirror of src/index.ts setSerializationKeyResolver mapping, inlined so the
// test stays hermetic. If the real resolver changes, update both sides.
function seedResolver(
  q: GroupQueue,
  jidToFolder: Record<string, string>,
): void {
  q.setSerializationKeyResolver((groupJid: string) => {
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) {
      const baseJid = groupJid.slice(0, agentSep);
      const agentId = groupJid.slice(agentSep + '#agent:'.length);
      const folder = jidToFolder[baseJid] || baseJid;
      return `${folder}#${agentId}`;
    }
    const taskSep = groupJid.indexOf('#task:');
    if (taskSep >= 0) {
      const baseJid = groupJid.slice(0, taskSep);
      const taskId = groupJid.slice(taskSep + '#task:'.length);
      const folder = jidToFolder[baseJid] || baseJid;
      return `${folder}#task:${taskId}`;
    }
    return jidToFolder[groupJid] || groupJid;
  });
}

describe('GroupQueue.listActiveDescendantJids', () => {
  test('returns active sub-agent and task virtual JIDs in the same folder', () => {
    const q = new GroupQueue();
    seedResolver(q, {
      'web:main': 'main',
      'feishu:F1': 'main', // IM sibling on same folder
      'web:other': 'other',
    });
    seedActive(q, [
      'web:main',               // main session, NOT a descendant
      'web:main#agent:a1',      // sub-agent spawned from web:main
      'feishu:F1#agent:a2',     // sub-agent spawned from IM sibling, same folder
      'web:main#task:t1',       // scheduled task
      'web:other#agent:a3',     // different folder — must NOT match
    ]);

    const out = q.listActiveDescendantJids('web:main').sort();
    expect(out).toEqual(
      ['web:main#agent:a1', 'feishu:F1#agent:a2', 'web:main#task:t1'].sort(),
    );
  });

  test('excludes idle runners', () => {
    const q = new GroupQueue();
    seedResolver(q, { 'web:main': 'main' });
    seedActive(q, ['web:main#agent:a1']);
    seedIdle(q, ['web:main#agent:a2']);

    expect(q.listActiveDescendantJids('web:main')).toEqual([
      'web:main#agent:a1',
    ]);
  });

  test('does not return the base JID itself, only descendants', () => {
    const q = new GroupQueue();
    seedResolver(q, { 'web:main': 'main' });
    seedActive(q, ['web:main']);

    expect(q.listActiveDescendantJids('web:main')).toEqual([]);
  });

  test('handles jids without a serialization resolver mapping', () => {
    const q = new GroupQueue();
    // No resolver set — fallback returns the jid as its own key
    seedActive(q, ['raw:jid#agent:x']);

    // `raw:jid` as its own key → descendants are "raw:jid#..." family.
    // raw:jid#agent:x → `raw:jid#agent:x` → does it start with `raw:jid#`? Yes.
    expect(q.listActiveDescendantJids('raw:jid')).toEqual(['raw:jid#agent:x']);
  });
});

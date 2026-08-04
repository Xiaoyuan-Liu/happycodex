import { describe, expect, test, vi } from 'vitest';
import {
  buildFeishuInboundRouteTarget,
  parseFeishuRouteTarget,
  resolveFeishuReplyMessageId,
  sendFeishuMessageToTarget,
  shouldUseFeishuReplyApi,
} from '../src/feishu.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';
import {
  getImRouteBaseJid,
  getImReplyRouteScope,
  resolveFeishuStreamingRoute,
  selectBatchImReplyRoute,
} from '../src/im-channel.js';

describe('parseFeishuRouteTarget', () => {
  test('parses thread/root metadata and marks thread replies', () => {
    expect(
      parseFeishuRouteTarget('oc_123#thread:omt_thread#root:om_root'),
    ).toEqual({
      raw: 'oc_123#thread:omt_thread#root:om_root',
      chatId: 'oc_123',
      threadId: 'omt_thread',
      rootMessageId: 'om_root',
      replyMessageId: undefined,
      replyInThread: true,
    });
  });

  test('keeps bare chat targets as non-thread replies', () => {
    expect(parseFeishuRouteTarget('oc_123')).toEqual({
      raw: 'oc_123',
      chatId: 'oc_123',
      threadId: undefined,
      rootMessageId: undefined,
      replyMessageId: undefined,
      replyInThread: false,
    });
  });

  test('keeps normal reply trees separate from Feishu topics', () => {
    expect(
      buildFeishuInboundRouteTarget(
        'oc_123',
        'om_user',
        'om_root',
        undefined,
      ),
    ).toEqual({
      raw: 'oc_123#reply:om_user',
      chatId: 'oc_123',
      threadId: undefined,
      rootMessageId: undefined,
      replyMessageId: 'om_user',
      replyInThread: false,
    });
  });

  test('keeps real Feishu thread routes attached to their root', () => {
    expect(
      buildFeishuInboundRouteTarget(
        'oc_123',
        'om_user',
        'om_root',
        'omt_thread',
      ),
    ).toEqual(
      parseFeishuRouteTarget('oc_123#thread:omt_thread#root:om_root'),
    );
  });

  test('keeps top-level inbound messages as bare create targets', () => {
    expect(
      buildFeishuInboundRouteTarget('oc_123', 'om_user'),
    ).toEqual(parseFeishuRouteTarget('oc_123'));
  });

  test('does not use reply API for bare chat targets', () => {
    expect(shouldUseFeishuReplyApi(parseFeishuRouteTarget('oc_123'))).toBe(false);
    expect(
      shouldUseFeishuReplyApi(
        parseFeishuRouteTarget('oc_123#thread:omt_thread#root:om_root'),
      ),
    ).toBe(true);
  });

  test('prefers the exact inbound message and supports legacy root routes', () => {
    expect(
      resolveFeishuReplyMessageId(
        parseFeishuRouteTarget('oc_123#root:om_root#reply:om_user'),
      ),
    ).toBe('om_user');
    expect(
      resolveFeishuReplyMessageId(
        parseFeishuRouteTarget('oc_123#thread:omt_thread#root:om_root'),
      ),
    ).toBe('om_root');
    expect(
      resolveFeishuReplyMessageId(
        parseFeishuRouteTarget(
          'oc_123#thread:omt_thread#root:om_root#reply:om_user',
        ),
      ),
    ).toBe('om_root');
    const legacyRootOnly = parseFeishuRouteTarget('oc_123#root:om_root');
    expect(resolveFeishuReplyMessageId(legacyRootOnly)).toBe('om_root');
    expect(legacyRootOnly.replyInThread).toBe(false);
  });
});

describe('getImReplyRouteScope', () => {
  test('ignores per-message reply anchors in the same Feishu chat', () => {
    expect(getImReplyRouteScope('feishu:oc_123#reply:om_one')).toBe(
      'feishu:oc_123',
    );
    expect(getImReplyRouteScope('feishu:oc_123#reply:om_two')).toBe(
      'feishu:oc_123',
    );
  });

  test('normalizes detailed Feishu routes to their registered group JID', () => {
    expect(
      getImRouteBaseJid(
        'feishu:oc_123#thread:omt_one#root:om_root#reply:om_user',
      ),
    ).toBe('feishu:oc_123');
    expect(getImRouteBaseJid('discord:channel_123')).toBe(
      'discord:channel_123',
    );
  });

  test('keeps distinct Feishu threads in distinct source scopes', () => {
    expect(
      getImReplyRouteScope(
        'feishu:oc_123#thread:omt_one#root:om_root_one',
      ),
    ).toBe('feishu:oc_123#thread:omt_one');
    expect(
      getImReplyRouteScope(
        'feishu:oc_123#thread:omt_two#root:om_root_two',
      ),
    ).toBe('feishu:oc_123#thread:omt_two');
  });

  test('selects the latest exact reply anchor for a same-chat batch', () => {
    expect(
      selectBatchImReplyRoute('web:workspace', [
        'feishu:oc_123#reply:om_one',
        'feishu:oc_123#reply:om_two',
      ]),
    ).toBe('feishu:oc_123#reply:om_two');
  });

  test('does not mirror mixed Web and IM batches back to Feishu', () => {
    expect(
      selectBatchImReplyRoute('web:workspace', [
        'feishu:oc_123#reply:om_one',
        'web:workspace',
      ]),
    ).toBeNull();
  });

  test('retains the exact route for direct IM chats', () => {
    expect(
      selectBatchImReplyRoute('feishu:oc_123', [
        'feishu:oc_123#reply:om_user',
      ]),
    ).toBe('feishu:oc_123#reply:om_user');
  });

  test('does not redirect a direct IM batch to another chat or channel', () => {
    expect(
      selectBatchImReplyRoute('feishu:oc_123', [
        'feishu:oc_other#reply:om_user',
      ]),
    ).toBe('feishu:oc_123');
    expect(
      selectBatchImReplyRoute('feishu:oc_123', ['discord:channel_123']),
    ).toBe('feishu:oc_123');
  });

  test('returns no route for an empty batch', () => {
    expect(selectBatchImReplyRoute('web:workspace', [])).toBeNull();
  });
});

describe('resolveFeishuStreamingRoute', () => {
  test('maps bare, normal-reply, and thread targets to controller options', () => {
    expect(resolveFeishuStreamingRoute('oc_123')).toEqual({
      chatId: 'oc_123',
      replyToMsgId: undefined,
      replyInThread: false,
    });
    expect(resolveFeishuStreamingRoute('oc_123#reply:om_user')).toEqual({
      chatId: 'oc_123',
      replyToMsgId: 'om_user',
      replyInThread: false,
    });
    expect(
      resolveFeishuStreamingRoute(
        'oc_123#thread:omt_thread#root:om_root',
      ),
    ).toEqual({
      chatId: 'oc_123',
      replyToMsgId: 'om_root',
      replyInThread: true,
    });
  });
});

describe('sendFeishuMessageToTarget', () => {
  function createClient() {
    return {
      im: {
        message: { reply: vi.fn().mockResolvedValue({}) },
        v1: { message: { create: vi.fn().mockResolvedValue({}) } },
      },
    };
  }

  test('creates a normal chat message for a bare target', async () => {
    const client = createClient();
    const target = buildFeishuInboundRouteTarget('oc_123', 'om_user');
    await sendFeishuMessageToTarget(
      client as any,
      target.raw,
      'text',
      '{"text":"hello"}',
    );

    expect(client.im.message.reply).not.toHaveBeenCalled();
    expect(client.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_123',
        msg_type: 'text',
        content: '{"text":"hello"}',
      },
    });
  });

  test('replies to the current message without opening a topic for root-only routes', async () => {
    const client = createClient();
    const target = buildFeishuInboundRouteTarget(
      'oc_123',
      'om_user',
      'om_root',
    );
    await sendFeishuMessageToTarget(
      client as any,
      target.raw,
      'text',
      '{"text":"hello"}',
    );

    expect(client.im.v1.message.create).not.toHaveBeenCalled();
    expect(client.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_user' },
      data: {
        content: '{"text":"hello"}',
        msg_type: 'text',
      },
    });
  });

  test('replies to the root inside real thread routes', async () => {
    const client = createClient();
    const target = buildFeishuInboundRouteTarget(
      'oc_123',
      'om_user',
      'om_root',
      'omt_thread',
    );
    await sendFeishuMessageToTarget(
      client as any,
      target.raw,
      'text',
      '{"text":"hello"}',
    );

    expect(client.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: {
        content: '{"text":"hello"}',
        msg_type: 'text',
        reply_in_thread: true,
      },
    });
  });

  test('keeps legacy root-only routes deliverable without opening a topic', async () => {
    const client = createClient();
    await sendFeishuMessageToTarget(
      client as any,
      'oc_123#root:om_old',
      'text',
      '{"text":"hello"}',
    );

    expect(client.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_old' },
      data: {
        content: '{"text":"hello"}',
        msg_type: 'text',
      },
    });
  });
});

describe('StreamingCardController Feishu thread reply', () => {
  test('passes reply_in_thread when creating the initial streaming card', async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi.fn().mockResolvedValue({ data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create: vi.fn() } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      ...resolveFeishuStreamingRoute(
        'oc_123#thread:omt_thread#root:om_root',
      ),
    });

    controller.setThinking();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply.mock.calls[0]![0].data).toMatchObject({
      msg_type: 'interactive',
      reply_in_thread: true,
    });
    expect(reply.mock.calls[0]![0].path).toEqual({ message_id: 'om_root' });
  });

  test('replies to a normal reply-tree message without opening a topic', async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi.fn().mockResolvedValue({ data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create: vi.fn() } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      ...resolveFeishuStreamingRoute('oc_123#reply:om_user'),
    });

    controller.setThinking();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply.mock.calls[0]![0].path).toEqual({ message_id: 'om_user' });
    expect(reply.mock.calls[0]![0].data).not.toHaveProperty('reply_in_thread');
  });

  test('creates a top-level card for a bare route', async () => {
    const reply = vi.fn();
    const create = vi
      .fn()
      .mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi.fn().mockResolvedValue({ data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      ...resolveFeishuStreamingRoute('oc_123'),
    });

    controller.setThinking();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(reply).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![0]).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_123', msg_type: 'interactive' },
    });
  });

  test('preserves trace link when usage patch updates a legacy completed card', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi.fn().mockRejectedValue(new Error('streaming unavailable')),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply: vi.fn() },
        v1: { message: { create, patch } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_123',
    });
    controller.setTraceUrl('https://happy.example/chat/main?trace=1');
    controller.append('hello');

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await controller.complete('hello');
    await controller.patchUsageNote({
      inputTokens: 10,
      outputTokens: 5,
      costUSD: 0.01,
      durationMs: 1000,
      numTurns: 1,
    });

    const finalContent = patch.mock.calls.at(-1)?.[0]?.data?.content;
    expect(finalContent).toContain('查看完整运行轨迹');
    expect(finalContent).toContain('happy.example/chat/main');
    expect(finalContent).toContain('10 / 5 tokens');
  });
});

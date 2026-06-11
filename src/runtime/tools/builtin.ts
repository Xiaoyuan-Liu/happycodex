/**
 * HappyClaw 17 个内置工具的 dynamicTools 定义（A4：12 → 17，补齐上游完整面）。
 *
 * 每个 ToolDefinition = spec（注册给 codex 的 JSON Schema）+ handler（解析 args → 调 ToolBridge → 回填）。
 * 工具名、描述、入参字段语义尽量对齐 HappyClaw 的 in-process MCP 工具
 * （见 container/agent-runner/src/mcp-tools.ts 的 createMcpTools）。
 *
 * A4 新增 5 个：send_image / send_file / discord_get_history / discord_get_channel_info /
 * discord_get_server_info（schema 与 IPC 字段逐字对齐上游；落盘字段命中主进程消费端 case）。
 *
 * handler 约定：
 *   - args 是 unknown，逐字段做运行时校验；缺必填 → toolTextResult('missing required field ...', false)。
 *   - 用 ctx.groupFolder 作为 bridge 的 folder 参数。
 *   - 不抛错：解析/校验失败一律用 success:false 的结果表达（bridge 抛出的运行时错误由
 *     registry.dispatch 兜底为 success:false，错误文案即 bridge 的诚实失败信息）。
 */

import { toolTextResult } from '../../appserver/protocol.js';
import { validateSkillId } from '../../skill-utils.js';
import type {
  ToolDefinition,
  ToolHandler,
  ScheduleSpec,
} from './types.js';

/** args 是否为可索引的对象（非 null、非数组）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 取一个必填的非空字符串字段；缺失/类型错/空串 → null。 */
function reqString(args: unknown, field: string): string | null {
  if (!isRecord(args)) return null;
  const v = args[field];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? v : null;
}

/** 取一个可选字符串字段；缺失/类型错 → undefined（空串保留为 undefined）。 */
function optString(args: unknown, field: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const v = args[field];
  if (typeof v !== 'string') return undefined;
  return v.trim().length > 0 ? v : undefined;
}

/** 缺必填字段的统一失败结果。 */
function missing(field: string) {
  return toolTextResult(`missing required field "${field}"`, false);
}

// ───────────────────────── 各工具 handler ─────────────────────────

const sendMessage: ToolHandler = async (args, ctx) => {
  const message = reqString(args, 'message');
  if (message === null) return missing('message');
  await ctx.bridge.sendMessage(ctx.groupFolder, message);
  return toolTextResult('消息已发送');
};

const sendImage: ToolHandler = async (args, ctx) => {
  const filePath = reqString(args, 'file_path');
  if (filePath === null) return missing('file_path');
  const caption = optString(args, 'caption');
  const r = await ctx.bridge.sendImage(ctx.groupFolder, filePath, caption);
  // 文案对齐上游：Image sent: {fileName} ({mimeType}, {KB}KB)
  return toolTextResult(
    `Image sent: ${r.fileName} (${r.mimeType}, ${(r.sizeBytes / 1024).toFixed(1)}KB)`,
  );
};

const sendFile: ToolHandler = async (args, ctx) => {
  const filePath = reqString(args, 'filePath');
  if (filePath === null) return missing('filePath');
  const fileName = reqString(args, 'fileName');
  if (fileName === null) return missing('fileName');
  await ctx.bridge.sendFile(ctx.groupFolder, filePath, fileName);
  return toolTextResult(`Sending file "${fileName}"...`);
};

/** Discord snowflake 形状（对齐上游 schema 的 ^\d{17,20}$）。 */
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

const discordGetHistory: ToolHandler = async (args, ctx) => {
  let limit: number | undefined;
  let before: string | undefined;
  if (isRecord(args)) {
    if (args.limit !== undefined) {
      const v = args.limit;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
        return toolTextResult(
          'invalid field "limit": expected an integer between 1 and 100',
          false,
        );
      }
      limit = v;
    }
    if (args.before !== undefined) {
      const v = args.before;
      if (typeof v !== 'string' || !DISCORD_SNOWFLAKE_RE.test(v)) {
        return toolTextResult(
          'invalid field "before": must be a Discord snowflake (17-20 digits)',
          false,
        );
      }
      before = v;
    }
  }
  const messages = await ctx.bridge.discordGetHistory(ctx.groupFolder, {
    ...(limit !== undefined ? { limit } : {}),
    ...(before !== undefined ? { before } : {}),
  });
  if (messages.length === 0) {
    return toolTextResult('No messages found in this channel.');
  }
  // 逐字段对齐上游格式化（tag / replyFlag / editFlag / attachments 行）。
  const formatted = messages
    .map((m) => {
      const tag = m.authorBot ? ' [bot]' : '';
      const editFlag = m.edited ? ' (edited)' : '';
      const replyFlag = m.replyToId ? ` ↪${m.replyToId}` : '';
      const attachStr =
        Array.isArray(m.attachments) && m.attachments.length > 0
          ? `\n  📎 ${m.attachments.map((a) => a.name).join(', ')}`
          : '';
      return `[${m.timestamp}] ${m.authorName}${tag}${replyFlag}${editFlag} (id=${m.id})\n  ${m.content || '(empty)'}${attachStr}`;
    })
    .join('\n\n');
  return toolTextResult(
    `Discord history (${messages.length} messages, oldest first):\n\n${formatted}`,
  );
};

const discordGetChannelInfo: ToolHandler = async (_args, ctx) => {
  const channel = await ctx.bridge.discordGetChannelInfo(ctx.groupFolder);
  return toolTextResult(`Discord channel info:\n${JSON.stringify(channel, null, 2)}`);
};

const discordGetServerInfo: ToolHandler = async (_args, ctx) => {
  const guild = await ctx.bridge.discordGetServerInfo(ctx.groupFolder);
  if (guild === null) {
    return toolTextResult(
      'This is a DM channel — no server (guild) information available.',
    );
  }
  return toolTextResult(`Discord server info:\n${JSON.stringify(guild, null, 2)}`);
};

const scheduleTask: ToolHandler = async (args, ctx) => {
  const name = reqString(args, 'name');
  if (name === null) return missing('name');
  const prompt = reqString(args, 'prompt');
  if (prompt === null) return missing('prompt');

  if (!isRecord(args)) return missing('schedule');
  const rawSchedule = args.schedule;
  if (!isRecord(rawSchedule)) return missing('schedule');

  const kind = rawSchedule.kind;
  let schedule: ScheduleSpec;
  if (kind === 'cron') {
    const expr = reqString(rawSchedule, 'expr');
    if (expr === null) return missing('schedule.expr');
    schedule = { kind: 'cron', expr };
  } else if (kind === 'interval') {
    const seconds = rawSchedule.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return toolTextResult(
        'invalid field "schedule.seconds": expected a positive number',
        false,
      );
    }
    schedule = { kind: 'interval', seconds };
  } else if (kind === 'once') {
    const at = reqString(rawSchedule, 'at');
    if (at === null) return missing('schedule.at');
    schedule = { kind: 'once', at };
  } else {
    return toolTextResult(
      'invalid field "schedule.kind": expected one of "cron" | "interval" | "once"',
      false,
    );
  }

  const { taskId } = await ctx.bridge.scheduleTask(ctx.groupFolder, {
    name,
    prompt,
    schedule,
  });
  return toolTextResult(`已创建定时任务，taskId=${taskId}`);
};

const listTask: ToolHandler = async (_args, ctx) => {
  const tasks = await ctx.bridge.listTasks(ctx.groupFolder);
  return toolTextResult(`共 ${tasks.length} 个任务：${JSON.stringify(tasks)}`);
};

const pauseTask: ToolHandler = async (args, ctx) => {
  const taskId = reqString(args, 'task_id');
  if (taskId === null) return missing('task_id');
  await ctx.bridge.pauseTask(ctx.groupFolder, taskId);
  return toolTextResult(`任务 ${taskId} 已暂停`);
};

const resumeTask: ToolHandler = async (args, ctx) => {
  const taskId = reqString(args, 'task_id');
  if (taskId === null) return missing('task_id');
  await ctx.bridge.resumeTask(ctx.groupFolder, taskId);
  return toolTextResult(`任务 ${taskId} 已恢复`);
};

const cancelTask: ToolHandler = async (args, ctx) => {
  const taskId = reqString(args, 'task_id');
  if (taskId === null) return missing('task_id');
  await ctx.bridge.cancelTask(ctx.groupFolder, taskId);
  return toolTextResult(`任务 ${taskId} 已取消`);
};

const registerGroup: ToolHandler = async (args, ctx) => {
  const jid = reqString(args, 'jid');
  if (jid === null) return missing('jid');
  const name = optString(args, 'name');
  await ctx.bridge.registerGroup(ctx.groupFolder, jid, name);
  return toolTextResult(`群组 ${jid} 已注册`);
};

const installSkill: ToolHandler = async (args, ctx) => {
  const name = reqString(args, 'name');
  if (name === null) return missing('name');
  // 包名形状校验对齐上游：owner/repo[@skill] 或 https?:// URL；非法直接失败、不触达 bridge。
  const pkg = name.trim();
  if (!/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) && !/^https?:\/\//.test(pkg)) {
    return toolTextResult(
      `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill`,
      false,
    );
  }
  const { installed } = await ctx.bridge.installSkill(ctx.groupFolder, pkg);
  const installedNote = installed && installed.length > 0 ? `：${installed.join(', ')}` : '';
  return toolTextResult(`Skill "${pkg}" 已安装${installedNote}（将在下次新会话生效）`);
};

const uninstallSkill: ToolHandler = async (args, ctx) => {
  const name = reqString(args, 'name');
  if (name === null) return missing('name');
  // skill ID 形状校验：单一真相 skill-utils.validateSkillId（routes/skills.ts 同源）。
  const skillId = name.trim();
  if (!validateSkillId(skillId)) {
    return toolTextResult(
      `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.`,
      false,
    );
  }
  await ctx.bridge.uninstallSkill(ctx.groupFolder, skillId);
  return toolTextResult(`Skill "${skillId}" 已卸载`);
};

const memoryAppend: ToolHandler = async (args, ctx) => {
  const content = reqString(args, 'content');
  if (content === null) return missing('content');
  const scope = optString(args, 'scope');
  await ctx.bridge.memoryAppend(ctx.groupFolder, content, scope);
  return toolTextResult('记忆已追加');
};

const memorySearch: ToolHandler = async (args, ctx) => {
  const query = reqString(args, 'query');
  if (query === null) return missing('query');
  const hits = await ctx.bridge.memorySearch(ctx.groupFolder, query);
  return toolTextResult(`命中 ${hits.length} 条：${JSON.stringify(hits)}`);
};

const memoryGet: ToolHandler = async (args, ctx) => {
  const memPath = reqString(args, 'path');
  if (memPath === null) return missing('path');
  const value = await ctx.bridge.memoryGet(ctx.groupFolder, memPath);
  return toolTextResult(value ?? '(not found)');
};

// ───────────────────────── 工具定义（spec + handler） ─────────────────────────

/**
 * 构造 HappyClaw 的 17 个内置工具定义（A4：补齐上游完整面）。
 * 返回顺序与 HappyClaw createMcpTools 中的工具语义对齐，名字保持同名。
 */
export function createBuiltinTools(): ToolDefinition[] {
  return [
    {
      spec: {
        name: 'send_message',
        description:
          '在你仍在运行时立即向当前用户或群组发送一条消息。用于进度更新或主动推送多条消息；可多次调用。' +
          '注意：作为定时任务运行时，你的最终输出不会自动发给用户——需要沟通时请用此工具。',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '要发送的消息文本',
            },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
      handler: sendMessage,
    },
    {
      spec: {
        name: 'send_image',
        description:
          '把工作区内的图片文件经 IM 发送给当前用户/群组。支持 PNG/JPEG/GIF/WebP，' +
          '大小上限 10MB；可选附带说明文字（caption）。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '图片文件路径（相对工作区根目录，或工作区内的绝对路径）',
            },
            caption: {
              type: 'string',
              description: '随图片一起发送的说明文字（可选）',
            },
          },
          required: ['file_path'],
          additionalProperties: false,
        },
      },
      handler: sendImage,
    },
    {
      spec: {
        name: 'send_file',
        description:
          '把工作区内的文件经 IM（飞书/Telegram/钉钉/QQ/Discord）发送到当前聊天。' +
          '路径相对于工作区/群组目录。支持 PDF、DOC、XLS、PPT、MP4、ZIP、SO 等，大小上限 30MB。',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: '相对工作区/群组目录的文件路径（如 "output/report.pdf"）',
            },
            fileName: {
              type: 'string',
              description: '展示用文件名（如 "report.pdf"）',
            },
          },
          required: ['filePath', 'fileName'],
          additionalProperties: false,
        },
      },
      handler: sendFile,
    },
    {
      spec: {
        name: 'schedule_task',
        description:
          '创建一个一次性或周期性定时任务。schedule 支持三种模式：' +
          'cron（标准 cron 表达式，如 "0 9 * * *" 每天 9 点）、' +
          'interval（每 N 秒运行一次）、once（在指定本地时间运行一次）。',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '任务名称',
            },
            prompt: {
              type: 'string',
              description: '任务触发时让 Agent 执行的指令/提示词',
            },
            schedule: {
              type: 'object',
              description: '调度配置，三选一：cron / interval / once',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['cron', 'interval', 'once'],
                  description: '调度类型',
                },
                expr: {
                  type: 'string',
                  description: 'cron 模式：cron 表达式，如 "*/5 * * * *"',
                },
                seconds: {
                  type: 'number',
                  description: 'interval 模式：两次运行间隔的秒数（正数）',
                },
                at: {
                  type: 'string',
                  description: 'once 模式：本地时间戳，如 "2026-02-01T15:30:00"',
                },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
          required: ['name', 'prompt', 'schedule'],
          additionalProperties: false,
        },
      },
      handler: scheduleTask,
    },
    {
      spec: {
        name: 'list_tasks',
        description:
          '列出当前会话的所有定时任务（管理员主容器可见全部任务）。返回任务的 id、名称与状态。' +
          '数据来自主进程权威任务表（请求-响应回执）；主进程未运行时降级为本进程排队快照。',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      handler: listTask,
    },
    {
      spec: {
        name: 'pause_task',
        description: '暂停一个定时任务，在恢复之前不会再触发。',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '要暂停的任务 ID',
            },
          },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
      handler: pauseTask,
    },
    {
      spec: {
        name: 'resume_task',
        description: '恢复一个已暂停的定时任务。',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '要恢复的任务 ID',
            },
          },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
      handler: resumeTask,
    },
    {
      spec: {
        name: 'cancel_task',
        description: '取消并删除一个定时任务。',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '要取消的任务 ID',
            },
          },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
      handler: cancelTask,
    },
    {
      spec: {
        name: 'register_group',
        description:
          '注册一个新群组/会话，使 Agent 能够响应该群组的消息（仅管理员主容器可用）。' +
          '需提供群组的 chat JID，可选提供展示名称。' +
          '注意：本构建中该工具暂不可用（缺少主进程必填的 folder 参数，调用必然失败）——' +
          '请引导管理员在 Web 界面注册群组。',
        inputSchema: {
          type: 'object',
          properties: {
            jid: {
              type: 'string',
              description: '群组的 chat JID（如 "feishu:oc_xxxx"）',
            },
            name: {
              type: 'string',
              description: '群组展示名称（可选）',
            },
          },
          required: ['jid'],
          additionalProperties: false,
        },
      },
      handler: registerGroup,
    },
    {
      spec: {
        name: 'discord_get_history',
        description:
          '拉取当前 Discord 频道或 DM 的最近消息（仅当前聊天是 Discord 频道时可用）。' +
          '每次最多返回 100 条（默认 50），按从旧到新排序；用 before 传消息 ID 可向更早分页。',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: '拉取条数（1-100，默认 50）',
            },
            before: {
              type: 'string',
              pattern: '^\\d{17,20}$',
              description:
                '消息 ID（snowflake）——只返回早于该消息的内容。用上一批最旧消息的 id 分页。',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      handler: discordGetHistory,
    },
    {
      spec: {
        name: 'discord_get_channel_info',
        description:
          '获取当前 Discord 频道元数据：名称、类型（guild_text/dm 等）、话题、NSFW 标记、' +
          '父分类 ID 与 guild ID。仅当前聊天是 Discord 频道时可用。',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      handler: discordGetChannelInfo,
    },
    {
      spec: {
        name: 'discord_get_server_info',
        description:
          '获取当前 Discord 频道所属服务器（guild）元数据：名称、描述、所有者 ID、成员数、图标 URL。' +
          'DM 频道返回 null（DM 不属于任何服务器）。仅当前聊天是 Discord 频道时可用。',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      handler: discordGetServerInfo,
    },
    {
      spec: {
        name: 'install_skill',
        description:
          '从 skills 注册表安装一个 skill，安装后将在后续会话中可用。' +
          '包名格式如 "anthropic/memory" 或 "owner/repo@skill"。',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '要安装的 skill 包名（如 owner/repo 或 owner/repo@skill）',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      handler: installSkill,
    },
    {
      spec: {
        name: 'uninstall_skill',
        description:
          '按 skill ID 卸载一个用户级 skill（项目级 skill 不可卸载）。ID 即 skill 的目录名。',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '要卸载的 skill ID（目录名，如 "memory"、"think"）',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      handler: uninstallSkill,
    },
    {
      spec: {
        name: 'memory_append',
        description:
          '将一段时效性记忆追加到记忆文件（仅追加，不覆盖已有内容）。' +
          '用于记录当天/短期相关信息：今日项目进展、临时决策、待办、会议要点等。可选 scope 指定记忆范围。',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '要追加的记忆内容',
            },
            scope: {
              type: 'string',
              description: '记忆范围/作用域（可选，如 global）',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
      },
      handler: memoryAppend,
    },
    {
      spec: {
        name: 'memory_search',
        description:
          '在记忆文件（CLAUDE.md、memory/、conversations/ 及其他 .md/.txt）中搜索关键词，' +
          '返回命中的文件路径与上下文片段。用于回忆过去的决策、偏好、项目上下文或对话历史。',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词或短语（不区分大小写）',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      handler: memorySearch,
    },
    {
      spec: {
        name: 'memory_get',
        description:
          '读取指定记忆文件的内容。通常在 memory_search 之后使用，以获取完整上下文。' +
          '若文件不存在返回 "(not found)"。',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '记忆文件的相对路径（如 "CLAUDE.md"、"memory/2026-01-15.md"）',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      handler: memoryGet,
    },
  ];
}

#!/usr/bin/env node
/**
 * fake-codex —— 仅供 AppServerClient 生命周期测试的假 `codex app-server`。
 *
 * 行为：
 *  - 读 newline-delimited JSON。对 `initialize` 立即回 { id, result: {...} }（让 client.start() 解握手）。
 *  - 对其它任何请求一律**不回复**（模拟"收下请求但永不回该 id 的响应"），用于：
 *      · 验证 close() 立即 reject 在途 pending（不等 SIGTERM→SIGKILL grace）。
 *      · 验证默认/显式 per-request 看门狗超时能解开永挂的 pending。
 *  - 环境变量 FAKE_CODEX_IGNORE_SIGTERM=1 → 忽略 SIGTERM（模拟卡死进程，逼 close() 走满 grace）。
 *
 * 注意：用纯 Node 内置实现，无第三方依赖，便于 vitest 直接 spawn。
 */
if (process.env.FAKE_CODEX_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {
    /* 故意吞掉，逼调用方走满 SIGTERM→grace→SIGKILL */
  });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    const trimmed = line.trim();
    if (trimmed.length > 0) handleLine(trimmed);
    idx = buffer.indexOf('\n');
  }
});

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg && msg.method === 'initialize' && msg.id !== undefined) {
    const result = {
      userAgent: 'fake-codex',
      codexHome: process.env.CODEX_HOME ?? '/tmp/fake-codex',
      platformFamily: 'unix',
      platformOs: 'darwin',
    };
    process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\n');
    return;
  }
  // 其它请求/通知：故意不回复。
}

// 保持进程存活，等待 stdin 关闭或被 kill。
process.stdin.resume();

/**
 * 测试替身：fake agent-runner（容器/host 进程边界的最小可控实现）。
 *
 * container-runner 测试经 env HAPPYCODEX_RUNNER_CMD 指向本脚本（`node tests/helpers/
 * fake-agent-runner.mjs`），从而：
 *   - 不依赖真实 codex CLI / dist 编译产物；
 *   - 把 runHostAgent 实际注入的 env / cwd / stdin（ContainerInput JSON）dump 到
 *     HAPPYCODEX_TEST_DUMP 指定的文件供断言；
 *   - 按 HAPPYCODEX_TEST_MODE 演不同剧本：
 *       success（默认）：发一封 success 信封（newSessionId=thr_fake）后 exit 0
 *       hang：不产出任何信封、长 sleep —— 驱动超时 kill 路径
 *       error-exit：写 stderr 后 exit 3 —— 驱动非零退出路径
 */

const OUTPUT_START_MARKER = '<<<HAPPYCODEX_OUTPUT_START>>>';
const OUTPUT_END_MARKER = '<<<HAPPYCODEX_OUTPUT_END>>>';

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function writeEnvelope(out) {
  process.stdout.write(`${OUTPUT_START_MARKER}${JSON.stringify(out)}${OUTPUT_END_MARKER}\n`);
}

const stdinRaw = await readStdin();

const dumpPath = process.env.HAPPYCODEX_TEST_DUMP;
if (dumpPath) {
  const { writeFileSync } = await import('node:fs');
  let stdinParsed = null;
  try {
    stdinParsed = JSON.parse(stdinRaw);
  } catch {
    /* keep null */
  }
  writeFileSync(
    dumpPath,
    JSON.stringify({ env: process.env, cwd: process.cwd(), stdin: stdinParsed }, null, 2),
  );
}

const mode = process.env.HAPPYCODEX_TEST_MODE || 'success';

if (mode === 'hang') {
  // 不产出任何信封：驱动 container-runner 的硬超时 killOnTimeout（SIGTERM 进程组）。
  setInterval(() => {}, 1000);
} else if (mode === 'error-exit') {
  process.stderr.write('fake-agent-runner: simulated failure\n');
  process.exit(3);
} else {
  writeEnvelope({
    status: 'stream',
    result: null,
    streamEvent: { eventType: 'text_delta', text: 'hello' },
    newSessionId: 'thr_fake',
  });
  writeEnvelope({
    status: 'success',
    result: 'hello',
    newSessionId: 'thr_fake',
    sourceKind: 'sdk_final',
    finalizationReason: 'completed',
  });
  process.exit(0);
}

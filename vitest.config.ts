/**
 * vitest 配置 —— 只跑 happycodex 自己的 tests/。
 *
 * upstream-happyclaw/ 是上游 HappyClaw 的只读参考快照（含其自带 tests/，依赖未安装、
 * 不在本项目可执行范围）。不加 include 限定时 vitest 默认 glob 会把快照里的测试一并
 * 扫进来导致大量无关失败，故显式锁定到 tests/。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});

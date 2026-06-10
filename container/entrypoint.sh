#!/bin/bash
set -e

# HappyCodex agent container entrypoint.
# 改装自 upstream-happyclaw/container/entrypoint.sh：卷权限修复 / env source / npm 全局包
# 持久化骨架保留；Claude 触点（CLAUDE_CONFIG_DIR / IS_SANDBOX / .claude skills 链接 /
# 容器内 tsc 重编译）删除或换 codex 等价（CODEX_HOME + dist 直跑）。

# Set permissive umask so files created by the container (node user, uid 1000)
# are writable by the host backend (agent user, uid 1002).
umask 0000

# Fix ownership on mounted volumes.
# Host uid may differ from container node user (uid 1000), especially in
# rootless podman where uid remapping causes EACCES on bind mounts.
chown -R node:node /home/node/.codex 2>/dev/null || true
chown -R node:node /home/node/.feishu-cli 2>/dev/null || true
chown -R node:node /workspace/group /workspace/global /workspace/memory /workspace/ipc 2>/dev/null || true

# Mark mounted directories as safe for git (CVE-2022-24765 ownership check).
# 使用通配符 '*' 因为挂载路径动态（extra mounts、customCwd），无法枚举具体目录。
git config --global --add safe.directory '*' 2>/dev/null || true

# Source environment variables from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

# CODEX_HOME: per-folder 隔离的 codex home（host 侧 FsCodexHomeProvisioner provision 后
# bind-mount 到 /home/node/.codex —— auth.json / config.toml / agents/ / hooks.json）。
# 上游此处为 CLAUDE_CONFIG_DIR=/home/node/.claude；codex 等价为 CODEX_HOME。
export CODEX_HOME=/home/node/.codex

# 工作区路径（上游 env 名与语义：均为 per-folder 路径；容器内为固定挂载点）。
export HAPPYCLAW_WORKSPACE_GROUP=/workspace/group
export HAPPYCLAW_WORKSPACE_IPC=/workspace/ipc
export HAPPYCLAW_WORKSPACE_GLOBAL=/workspace/global
export HAPPYCLAW_WORKSPACE_MEMORY=/workspace/memory

# Persist Agent's `npm install -g <pkg>` to per-user mounted extra dir.
# 容器是 docker run --rm 模式，把 npm prefix 指向已挂载的 /workspace/extra/.npm-global
# （host 端 data/extra/{folder}/.npm-global/，per-user 隔离）让全局包持久化。
NPM_GLOBAL_DIR=/workspace/extra/.npm-global
mkdir -p "$NPM_GLOBAL_DIR/bin" "$NPM_GLOBAL_DIR/lib"
chown -R node:node "$NPM_GLOBAL_DIR" 2>/dev/null || true
cat > /home/node/.npmrc <<EOF
prefix=$NPM_GLOBAL_DIR
EOF
chown node:node /home/node/.npmrc 2>/dev/null || true
# append 而非 prepend，避免持久化的 npm shim 屏蔽镜像内置的 codex CLI
export PATH="$PATH:$NPM_GLOBAL_DIR/bin"

# tombstone（happycodex）：上游此处把 builtin/project/user skills 符号链接进
# /home/node/.claude/skills/（Claude skills 发现机制）。codex 侧 context/技能注入走
# AGENTS.md 路线（per-folder CODEX_HOME 物化），留待 context-resolver 阶段。
# tombstone（happycodex）：上游此处 `npx tsc` 重编译热挂载的 agent-runner src；
# happycodex 镜像直接 COPY 编译后的 dist/，无容器内编译步骤。

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Fix permissions on exit: 某些工具会以 0600 写文件，宿主机后端（agent user）读不到。
# The trap runs as root after the node process exits.
cleanup() {
  chmod -R a+rwX /home/node/.codex 2>/dev/null || true
  chmod -R a+rwX /workspace/group 2>/dev/null || true
}
trap cleanup EXIT

# Drop privileges and execute agent-runner as node user
runuser -u node -- node /app/dist/agent-runner.js < /tmp/input.json

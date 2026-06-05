# happycodex —— Codex 版 HappyClaw 运行时（Stage 0-3）
# 各 target 包装对应 npm script。前置：codex 已登录、CODEX_HOME 指向有效配置目录。

.PHONY: help typecheck test poc-stream poc-steer poc-resume poc-tools

help: ## 列出所有可用 target
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

typecheck: ## TypeScript 全量类型检查（tsc --noEmit）
	npm run typecheck

test: ## 跑单测（vitest run）
	npm run test

poc-stream: ## PoC: 验证 R1 token 流式（需真实 codex app-server）
	npm run poc:stream

poc-steer: ## PoC: 验证 R2 运行中注入 turn/steer（需真实 codex app-server）
	npm run poc:steer

poc-resume: ## PoC: 验证跨进程 thread/resume 续接（需真实 codex app-server）
	npm run poc:resume

poc-tools: ## PoC: 验证 R3 dynamicTools 12 工具端到端（需真实 codex app-server）
	npm run poc:tools

# HappyCodex Agent Container
# Runs the codex engine (pinned codex CLI + compiled agent-runner) in an isolated Linux VM
# with full toolchain.
#
# 改装自 upstream-happyclaw/container/Dockerfile：工具链层（apt / uv / chromium / feishu-cli /
# agent-browser）保留思路；Claude SDK / claude CLI 层换成 pin 版 codex CLI + 本仓引擎产物。
#
# 构建（构建上下文为**项目根**，先产出 dist/）：
#   npm run build
#   docker build -f container/Dockerfile -t happycodex-agent:latest .
#
# TODO（A1-2 端到端）：真实 docker build/run 验证（本机可能未起 docker daemon）。

FROM node:22-slim

# Install system packages (organized by category)
# NOTE: Keep this layer BEFORE `COPY --from=ghcr.io/astral-sh/uv:latest` so that
# uv:latest digest churn (frequent releases) does not invalidate this ~440MB layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # --- Browser & fonts ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    # --- Chromium shared library deps ---
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Build tools & compilers ---
    build-essential \
    cmake \
    pkg-config \
    # --- Python ecosystem ---
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # --- Core CLI tools ---
    curl \
    wget \
    git \
    zsh \
    jq \
    tree \
    file \
    less \
    bc \
    patch \
    rsync \
    # --- Compression ---
    zip \
    unzip \
    xz-utils \
    bzip2 \
    # --- Network ---
    openssh-client \
    dnsutils \
    iputils-ping \
    # --- Process & system ---
    procps \
    lsof \
    # --- Text search & dev ---
    ripgrep \
    fd-find \
    shellcheck \
    # --- Multimedia ---
    ffmpeg \
    imagemagick \
    ghostscript \
    graphviz \
    # --- Document & PDF ---
    poppler-utils \
    pandoc \
    # --- Database clients ---
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    # --- Locale ---
    locales \
    && rm -rf /var/lib/apt/lists/* \
    # Set up UTF-8 locale
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    # Symlink fd-find → fd (Debian names it fdfind)
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Copy uv from official image (multi-arch, no extra download).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# CACHEBUST 触发下方 npm install 重跑（agent-browser 跟 latest）。
# codex CLI 是 pin 版（行为基线锁定在 PoC 实测版本），不受 CACHEBUST 影响语义。
ARG CACHEBUST=1
RUN npm install -g agent-browser
# Claude SDK/claude CLI 层 → pin 版 codex CLI（与 PoC 实测行为基线一致）
RUN npm install -g @openai/codex@0.137.0

# Install feishu-cli (binary + builtin skills), 始终跟踪 latest release。
# 通过 302 redirect 从 github.com/releases/latest 的 Location header 提取 tag
# （不经 api.github.com 规避 rate limit）。CACHEBUST 已在此前触发。
ARG TARGETARCH
RUN set -e && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    VERSION=$(curl -sI "https://github.com/riba2534/feishu-cli/releases/latest" \
      | grep -i '^location:' | head -1 \
      | sed 's|.*/tag/\([^[:space:]]*\).*|\1|' | tr -d '\r\n') && \
    if [ -z "$VERSION" ]; then echo "ERROR: 无法从 github.com 302 redirect 解析 feishu-cli 最新版本"; exit 1; fi && \
    echo "Installing feishu-cli $VERSION for $ARCH" && \
    curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_linux-${ARCH}.tar.gz" \
      | tar -xz --strip-components=1 -C /usr/local/bin && \
    feishu-cli --version && \
    mkdir -p /opt/builtin-skills && \
    SKILLS_TMP=$(mktemp -d) && \
    curl -fsSL "https://github.com/riba2534/feishu-cli/archive/refs/tags/${VERSION}.tar.gz" \
      | tar -xz -C "$SKILLS_TMP" && \
    cp -r "$SKILLS_TMP"/*/skills/. /opt/builtin-skills/ && \
    rm -rf "$SKILLS_TMP" && \
    ls /opt/builtin-skills/

# 引擎产物：宿主侧 `npm run build` 产出的 dist/（零外部 npm 运行时依赖，
# agent-runner 引擎图只用 node:* 内建模块，无需 node_modules）。
# 上游的 agent-runner src 热挂载 + 容器内 tsc 重编译路线作废——代码变更需重建镜像。
COPY dist/ /app/dist/

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/memory /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (runs as root, drops to node user via runuser)
COPY container/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install oh-my-zsh for node user (ys theme). Best-effort with timeout cap —
# cosmetic only, must not abort the image build on flaky networks.
RUN timeout -k 5 90 su - node -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended' \
    && sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/' /home/node/.zshrc \
    && chsh -s /bin/zsh node \
    || echo "⚠️ oh-my-zsh setup skipped (network slow/unavailable); container keeps default shell"

# Entrypoint runs as root to fix volume permissions, then drops to node user.
# Do NOT add USER node here — entrypoint handles the privilege drop.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

---
title: 安装
description: 安装 CodexCommander(ccx)代理及其前置条件,并验证它能够运行。
---

打包或本地链接的构建会提供 `ccx` 和 `codexcommander` 两个等价命令，它们都指向同一个基于 Bun 的
小型本地 HTTP 服务器。模型请求会发往路由所选的 provider；当已路由模型需要时，可选的
vision 和网络搜索 sidecar 也可以使用你的 ChatGPT 登录凭据。

## 前置条件

| 要求 | 原因 |
| --- | --- |
| **[Bun](https://bun.sh)** | 源码运行时和仓库脚本直接通过 Bun 执行。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App 或 SDK) | CodexCommander 所代理的客户端。CodexCommander 会写入 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。 |
| 一个 provider 账号或 API key | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API key、一个 OpenAI 兼容端点,或你的 ChatGPT 登录凭据。 |

## 运行源码检出目录

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start
```

注册表包目前尚未发布。在此检出目录中，请将 `ccx <args>` 替换为
`bun run src/cli/index.ts <args>`。在另一个终端中验证运行时：

```bash
bun run src/cli/index.ts --version
```

## 开发模式

编辑 UI 时，请分别运行代理和仪表盘：

```bash
bun run dev:proxy   # 以开发模式启动代理 API (src/cli/index.ts start)
bun run dev:gui     # 启动仪表盘 dev 服务器 (另一个终端)
```

`bun run dev` 是 `bun run dev:proxy` 的别名。代理 API 暴露 `/healthz`、`/v1/responses`、
`/api/*`;只有在 `bun run build:gui` 生成 `gui/dist` 之后,`GET /` 才会提供打包后的仪表盘。
开发仪表盘时,请用 `bun run dev:gui` 单独运行前端。macOS 配套应用可在同一检出目录中通过 `bun run test:macos && bun run build:macos` 构建，源码构建位于 `dist/macos/CodexCommander.app`。

## 会创建哪些内容

CodexCommander 状态文件位于 `$CODEXCOMMANDER_HOME`（默认 `~/.codexcommander`），Codex 集成文件位于
`$CODEX_HOME`（默认 `~/.codex`）。

| 路径 | 用途 |
| --- | --- |
| `$CODEXCOMMANDER_HOME/config.json` | 你的 provider、默认 provider、端口及选项。 |
| `$CODEXCOMMANDER_HOME/codexcommander.pid` | 正在运行的代理的 PID（单实例保护）。 |
| `$CODEXCOMMANDER_HOME/runtime-port.json` | 当前 PID、主机名和端口，包括自动选择的备用端口。 |
| `$CODEXCOMMANDER_HOME/auth.json` | 执行 `ccx login` 后保存的 OAuth 凭据。 |
| `$CODEXCOMMANDER_HOME/catalog-backup-<catalog-id>.json` | CodexCommander 修改 Codex 模型目录前创建的备份。 |
| `$CODEX_HOME/config.toml` | 仅监听回环地址时，CodexCommander 会添加由自身标记管理的根级 `openai_base_url`；监听非回环地址时，则使用 `model_provider = "codexcommander"` 和 `[model_providers.codexcommander]`，以便 Codex 发送 API 认证 header。 |
| `$CODEX_HOME/codexcommander.config.toml` | 与 Codex 主配置一同写入的备用/参考 profile。 |
| `$CODEX_HOME/codexcommander-catalog.json` | 供 Codex 使用的原生与已路由模型目录。 |

:::note
CodexCommander 绝不会删除你的 Codex 配置。每次注入都是可逆的 —— `ccx stop`、`ccx restore`
或 `ccx eject` 会精确剥离 CodexCommander 所添加的那些行,并恢复原生 Codex。
:::

## 下一步

继续阅读 [快速开始](/zh-cn/getting-started/quickstart/) 以配置你的第一个 provider,
或阅读 [工作原理](/zh-cn/getting-started/how-it-works/) 了解其架构。

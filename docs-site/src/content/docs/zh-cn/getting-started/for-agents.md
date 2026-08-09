---
title: Agent 快速上手
description: 为受代理驱动或脚本控制的终端安装并操作 CodexCommander，同时不跨越用户同意边界。
---

本页面面向在终端中工作的 AI agent 或脚本用户。重点说明命令、退出状态，以及安全的无头操作。面向人工引导的流程，请使用 [Quickstart](/getting-started/quickstart/)。仪表板仍可用于交互式配置；参见 [Web Dashboard](/guides/web-dashboard/)。

## 安装 CodexCommander

使用现有的源码检出目录。注册表包目前尚未发布：

```bash
bun install
bun run build:gui
bun run src/cli/index.ts --version
```

选择一种方式运行代理：

```bash
# Foreground: blocks this terminal until stopped.
bun run src/cli/index.ts start

# Background: installs or updates the service, then starts it.
bun run src/cli/index.ts service
```

在交互式终端中运行 `ccx init`。如果 `ccx start` 正占用前台，请使用第二个终端：

```bash
bun run src/cli/index.ts init
```

下文的 `ccx <args>` 在此检出目录中可以写成 `bun run src/cli/index.ts <args>`。

该向导会写入 `$CODEXCOMMANDER_HOME/config.json`（通常是 `~/.codexcommander/config.json`）。它还可以把代理地址注入 Codex 的 `config.toml`，并安装可选的 Codex 自动启动 shim。`ccx init` 从不启动代理。若要完全非交互式地完成设置，请改用下面所示的 `ccx provider add` 来配置提供方，而不是运行向导。

## 检查无头安装

在脚本和 agent 运行中使用这些只读检查：

```bash
ccx status
ccx doctor
ccx health --json
```

`ccx status` 会报告代理和服务状态。`ccx doctor` 会诊断本地环境、网络、Codex runtime 和账户健康问题。`ccx health` 在代理健康时退出 `0`，否则退出 `1`；`--json` 会返回结构化输出。

由管理 API 支持的命令，例如 `ccx combo set`，会联系正在运行的代理。如果找不到正在运行的代理，或者 API 不可达，CLI 会将其视为 `503` 失败并以非零状态退出。请先启动前台代理或后台服务，再重试。完整的命令和端点表面请参见 [CLI reference](/reference/cli/) 和 [Management API](/reference/management-api/)。

## 无需仪表板添加提供方和组合

可以按名称添加注册表中的提供方。例如，下面的命令会添加 Anthropic API key 预设并将其设为默认提供方：

```bash
ccx provider add anthropic-apikey \
  --api-key "$ANTHROPIC_API_KEY" \
  --set-default
```

`ccx provider add` 会写入本地配置。如果已经有正在运行的代理，并且你希望立刻把模型同步到 Codex，请加上 `--sync`；否则之后再运行 `ccx sync`。不在注册表中的自定义提供方同时需要 `--adapter` 和 `--base-url`。

在所有目标提供方都配置好且代理正在运行后，创建一个故障转移 combo：

```bash
ccx combo set main \
  --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol \
  --strategy failover
```

目标使用 `provider/model` 语法，并以逗号分隔。生成的虚拟模型是 `combo/main`。有关策略、权重、粘性路由和失败行为，请参见 [Combos](/guides/combos/)。

## 远程和 LAN 绑定

默认的回环绑定不需要 API token。非回环绑定，例如 `0.0.0.0`，则需要 `CODEXCOMMANDER_API_AUTH_TOKEN`；没有它，代理会拒绝启动。请在 `ccx start` 之前设置该变量，或者在 `ccx service install` 之前设置，这样服务就能接收到它：

```bash
export CODEXCOMMANDER_API_AUTH_TOKEN="your-secret-token"
ccx service install
```

之后，客户端必须对其管理请求和模型请求进行身份验证。在把 CodexCommander 暴露到本机之外之前，请先阅读 [Configuration](/reference/configuration/) 中的远程访问规则。

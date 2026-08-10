---
title: CLI 代理、路由与集成
description: 多代理、combo、可观测性、访问、集成、系统和配置命令。
---

这些命令用于控制代理策略和路由，检查实时代理，并将受支持的客户端连接到 CodexCommander。

## Agent policy

### `ccx agent <status|injection|effort|subagents|fallback|sidecar> ...`

管理无头多代理列表、effort 上限、提示注入、回退和 sidecar 设置。使用 `status` 查看当前策略。有关 surface 模式、委派、effort 和回退行为如何协同工作，请参见 [子代理 surface](/guides/sub-agent-surface/)。

```bash
ccx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ccx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

管理 Codex 的 `multi_agent_v2` 功能标志和三态多代理 surface 模式。

| 子命令 | 动作 |
| --- | --- |
| `status`（默认） | 报告当前的 v2 标志、多代理模式和线程并发数。 |
| `on` | 启用 `multi_agent_v2` 功能并重新同步目录。 |
| `off` | 禁用 `multi_agent_v2` 功能并重新同步目录。 |
| `mode v1` | 强制所有模型使用 v1，禁用原生 v2，并保留当前线程上限。 |
| `mode default` | 遵循上游模型的 surface 固定配置。 |
| `mode v2` | 强制所有模型使用 v2，启用原生 v2，并保留当前线程上限。 |
| `threads <n>` | 将当前 v1/v2 线程上限设为一个至少为 1 的整数。 |

```bash
ccx v2 status
ccx v2 mode v1
ccx v2 mode default
ccx v2 on
ccx v2 threads 16
```

`mode` 子命令会将 `multiAgentMode` 写入 CodexCommander 配置，并重新同步 Codex 目录。模式和标志的切换会在有效的 v1/v2 Codex 键之间迁移当前的数值线程上限；如果切换失败，会恢复原始的 `config.toml`。模式、标志或 thread 的变更会更新 boot config。要影响运行中的 worker，请使用 `ccx sync --restart-codex`（或 dashboard 中的 **Apply agent catalog**），再启动新 task。

## Combo routing

### `ccx combo <list|show|set|remove> ...` · `ccx route combo ...`

管理 combo 的故障转移和轮询虚拟模型。`ccx route combo` 是层级别名；combo 目前是受支持的路由资源。目标使用 `provider/model[:weight],provider/model[:weight]`。

```bash
ccx combo list
ccx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` 支持 `--strategy`、`--sticky`、`--effort`、`--alias`、`--rename-from`、`--native-alias`
以及 `--display-name <label|->`（`-` 会清除标签）。native alias 只会接管一个当前受支持且
不带限定前缀的 OpenAI 裸 model id；带账号或提供方限定的 OpenAI 路由仍保持独立。

有关路由行为和配置指导，请参见 [Combos](/guides/combos/)。

## Observability and debug

### `ccx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

检查代理请求、用量、存储、内存和调试数据。直接别名如下：

| 别名 | 对应资源 |
| --- | --- |
| `ccx logs [filters] [--follow] [--json|--jsonl]` | `ccx observe logs` |
| `ccx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `ccx observe usage` |
| `ccx storage [--json]` | `ccx observe storage` |
| `ccx memory [--json]` | `ccx observe memory` |

```bash
ccx observe usage --range 30d --json
```

### `ccx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

通过正在运行的代理的管理 API 读取或更改运行时调试覆盖项。

```bash
ccx debug provider on|off|status|reset
ccx debug provider logs [-f|--follow]
ccx debug usage on|off|status|reset
ccx debug usage logs [-f|--follow]
```

没有指定作用域时，`ccx debug` 会输出用法；如果代理已停止，还会输出下次启动时的环境默认值。提供方调试默认来自 `CCX_DEBUG=1`；用量调试默认来自 `CODEXCOMMANDER_USAGE_DEBUG=1`。

## API access

### `ccx access <key|endpoints|models|test> ...`

管理 CodexCommander 准入 API 密钥，并检查外部端点和模型。`ccx api-key
<list|create|remove> ...` 是 `ccx access key` 的别名。

```bash
ccx access key create deployment
```

## Client integrations

### `ccx integration <claude|grok> ...`

管理受支持的 Claude 和 Grok 集成。下面的直接命令族会暴露各自客户端专属的控制项。

### `ccx claude [claude args...]`

确保代理正在运行，然后使用 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 以及 `config.claudeCode` 中当前的认证/辅助设置启动 Claude Code。对于 Claude Code 2.1.129 或更新版本，路由后的模型会通过稳定别名出现在原生 `/model` 选择器中。在较旧版本中，请使用 `ANTHROPIC_MODEL` 或 `/model <id>` 选择。用户自行导出的 `ANTHROPIC_*` 变量始终优先生效。

Claude Desktop 配置档案命令如下：

```text
ccx claude desktop apply                           Save and apply the four-family profile
ccx claude desktop show [--json]                   Show routes, families, and defaults
ccx claude desktop move <route> <family> [--default]
ccx claude desktop default <family> <route|none>
ccx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ccx claude desktop import <path> [--apply]         Validate and import JSON
```

这些 family 是 `opus`、`fable`、`sonnet` 和 `haiku`；新路由默认进入 `opus`。只有在该 family 为空时，`none` 才有效。Claude Code 设置请使用 `ccx claude config <status|set> ...`。

### `ccx opencode [opencode args...]`

确保代理正在运行，然后在 OpenCode 的内联运行时层（`OPENCODE_CONFIG_CONTENT`）中启动 opencode，并注入生成的 `provider.codexcommander` 块。现有的内联配置会被保留，仅本次启动会替换 `provider.codexcommander`。可能会读取全局或项目级 `opencode.json` 文件以警告已有覆盖，但不会修改磁盘上的文件。路由后的模型会显示为 `codexcommander/<provider>/<model>`。此启动器不会改变之后普通 `opencode` 的启动；只有单独的 opt-in 控制面板集成才会持久化 `provider.codexcommander`。

### `ccx grok <status|exclude|include|set|clear|apply> ...`

管理并应用 Grok Build 模型边界。

## Client config export

### `ccx export --client <opencode|pi>`

输出连接到正在运行代理的客户端配置。opencode 和 [Pi](/guides/pi/) 不是从环境变量，而是从各自的 JSON 配置中读取 providers，因此此命令会序列化 `codexcommander` provider 块——基础 URL、模型列表以及客户端的环境引用——供你合并进那个文件。

代理必须正在运行；该命令会解析其当前端口，读取 `/api/models`，并且只输出 Codex 当前可见的模型。

| 标志 | 动作 |
| --- | --- |
| `--client <opencode\|pi>` | 必需。选择客户端方言：opencode 的带键 `provider` 对象或 Pi 的 `providers` 数组。 |
| `--json` | 仅在 stdout 打印配置 JSON，这样重定向即可捕获字节级精确输出。包括 `--out` 写入提示在内的所有诊断信息都会输出到 stderr。 |
| `--out <path>` | 将配置写入 `<path>`。拒绝替换已存在的文件。 |
| `--force` | 允许 `--out` 替换已存在的文件。 |

```bash
ccx export --client opencode                     # config plus destination, merge warning, and counts
ccx export --client pi --json > pi-models.json   # byte-exact JSON for a pipe or a diff
ccx export --client opencode --out ~/codexcommander-opencode.json
```

不使用 `--json` 时，JSON 会先输出，随后是规范目标路径、合并警告、环境变量导出行，以及一个模型计数，并标明有多少行省略了上下文限制（客户端会对这些项应用自己的默认值）。

| 客户端 | 规范目标路径 | 下载文件名 | 环境变量 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json`（设置了 `XDG_CONFIG_HOME` 时以其为准） | `opencode.json` | `CODEXCOMMANDER_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | `CODEXCOMMANDER_API_KEY` |

这两个环境变量名称不同，而且每个客户端只会插入自己的那个。opencode 读取 `{env:CODEXCOMMANDER_OPENCODE_API_KEY}`；Pi 读取 `$CODEXCOMMANDER_API_KEY`。

:::caution[合并，不要替换]
`ccx export` 从不写入你的真实客户端配置。该命令只会打印目标路径供你手动合并，而 `--out` 在没有 `--force` 的情况下拒绝覆盖已有文件，因为替换配置会破坏其中已有的其他 providers、agents 和 MCP 条目。
:::

任何密钥都不会被序列化。配置里只包含客户端的环境引用，因此密钥仍保留在你的环境中。环回代理（`127.0.0.1`，默认值）根本不需要准入密钥——该引用只是不会被使用。只有当代理绑定到环回地址之外时才设置该变量；关于准入密钥如何签发，请参见 [远程访问](/reference/configuration/#remote-access)。上游 providers 自身的密钥则完全是另一回事，需要按 [Providers](/guides/providers/) 单独配置。

同一份负载会通过 `GET /api/client-config` 提供，并在仪表盘的 API 选项卡中渲染，因此 CLI、API 和 GUI 使用的是同一字节内容。

## Runtime and configuration

### `ccx system <status|settings|startup|diagnostics|sync> ...`

管理无头运行时设置、启动、同步和诊断。

```bash
ccx system settings --stream-mode eager-relay
```

### `ccx config <show|get|set|unset|validate|export|import> ...`

检查并安全修改已验证的 CodexCommander 配置。`show` 和 `get` 会隐藏密钥。导入会先验证再写入，并且需要 `--yes`。

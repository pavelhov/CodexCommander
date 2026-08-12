---
title: CLI 生命周期
description: 安装、启动、停止、服务、诊断和同步命令。
---

这些命令用于安装、运行、检查并修复本地 CodexCommander 代理及其 Codex 集成。

## 初始化

### `ccx init` · `ccx setup`

交互式初始化向导（`setup` 是 `init` 的别名）。会提示选择提供方（预设或自定义）、API key（字面量或 `${ENV}`）、默认模型和代理端口，并保存到 `~/.codexcommander/config.json`。它可选择让 Codex 经由一个已运行且由当前 home 的受保护 runtime 记录证明的代理路由，并可安装 Codex 自启动 shim。若无法证明这样的代理，Codex 会保持原生状态，之后由 `ccx start` 明确启动代理并切换路由。`init` 本身不会启动代理，也不会写入指向未经证明 listener 的路由。

## 代理生命周期

### `ccx start [--port <port>]`

启动代理服务器（首选端口 `10100`）。如果该端口已被占用，CodexCommander 会选择并记录另一个可用端口。它会写入 PID/运行时端口状态，并拒绝启动第二个存活实例。显式启动（`ccx start`、托盘中的 Start，以及显式的 `ccx service start`、`install` 或 `repair`）会启用 Codex 集成、把每个提供方的模型同步到 Codex 目录，并让 Codex 通过运行中的代理路由。自动 `ensure` 会保留有意设置的 OFF 状态。正常关闭时，它会恢复原生 Codex，除非它是作为受管服务启动的（`CCX_SERVICE=1`）。

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

先保存原生/OFF 选择并恢复原生 Codex 路由，再停止正在运行的代理（按 PID）并移除 PID 文件。如果无法验证原生路由，代理和服务会保持运行。如果安装了受管后台服务，`ccx stop` 会在恢复路由后停止该服务，使它无法重新拉起代理。Web 仪表盘的 **Stop** 按钮调用原始 `POST /api/stop`：它可以停止没有 supervisor 的代理，但若代理归已安装的 supervisor 所有则会拒绝。此时应使用 CLI 或托盘 Stop，让它在同一生命周期权限下先停止 manager。

### `ccx restart`

执行与 macOS 菜单栏 **Restart Proxy…** 相同的安全停止→启动事务：先恢复并验证原生 Codex，再终止旧代理/服务；随后由显式 Start 阶段启动新代理，并让 Codex 重新通过它路由。若重启失败，Codex 会保持原生路由。

### `ccx ensure`

以幂等方式确保后台代理正在运行，然后同步其当前模型目录。如果 `codexAutoStart` 为 `false`，它会打印自启动已禁用，并且不执行任何操作。

### `ccx restore [back]` · `ccx eject [back]`

在**不停止代理**的情况下恢复原生 Codex。原生逃生路径只会从 `$CODEX_HOME/config.toml` 中移除带有 CodexCommander 所有权标记的路由及其拥有的目录指针，并保留所有无关设置。它不会读取或重写目录、任务、历史记录或身份验证，也不需要 `repair` 命令或协调器数据库。`eject` 是 `restore` 的别名。生成的目录和缓存可能仍留在磁盘上，但原生 Codex 不再引用它们。此命令仅作用于 Codex，不会更改 Grok 或任何其他客户端集成。若要拆除所有受管原生客户端路由，请使用 `ccx stop` 或 `ccx uninstall`。

在任一命令后附加 `back`，即可在不改变代理生命周期的前提下，把普通 `codex` 重新指向一个已经在运行的代理。Route Back 是显式的 ON 转换。Recovery journal 是 CodexCommander 精确 config/profile 写入的受保护恢复检查点，并非另一个路由设置。当目标集成已为 ON、经过证明的 current-home 运行中代理拥有稳定 journal，且记录的 profile postimage 与当前 profile 完全匹配时，Route Back 接受两种 config：与记录的 postimage 完全一致，或者是稳定、精确、marker-owned 的 managed descendant，且移除受管理路由后可独立得到 native-safe config。因此允许 sync 之后对无关 Codex 偏好设置的修改。Route Back 会保留 active journal，并作为幂等 no-op 成功。若从 native/OFF 开始，现有协调机制只会退役能够证明已过期的 journal。所有者或 profile 错误、证明缺失、被篡改/custom/有歧义的路由、临时写入 surface 或观察竞争都会让 Codex 保持 native/OFF。请勿手动删除或编辑 journal：

```bash
ccx restore back
ccx eject back
```

Restore Native 或 Route Back 成功后，请完全退出 ChatGPT，重新打开后再开始新任务，让正在运行的 Codex 主机加载已保存的路由。

### `ccx uninstall` · `ccx remove`

在一个生命周期事务中停止服务和代理、移除服务和 Codex shim，并恢复且再次验证原生 Codex；仅当所有步骤都成功时才移除 CodexCommander 本地工件。`remove` 是 `uninstall` 的别名。配置清理需要规范的所有权元数据；无所有者或共享目录会保留原样。配置根目录中会保留一小对 owner/manifest 元数据，确保并发 Start 无法创建第二个生命周期锁命名空间。

## 状态与健康

### `ccx status [--json]`

输出只读诊断摘要：代理 PID、`/healthz` 可达性、仪表盘 URL、配置路径、默认提供方、Codex 自启动设置、服务状态、shim 状态，以及已脱敏的实际 Codex home。只有明确且高置信度的 Windows Orca 运行时 home 签名才会添加可执行的 App-home 不匹配警告；它绝不会自动更改 `CODEX_HOME`。

人类可读输出还会在 OAuth 登录摘要之后附加一个 **OAuth 健康** 区块：当所有已知账户都健康时显示 `OAuth health: ok`；否则显示 `OAuth health: warning`，并为每个不健康账户提供一行脱敏信息（提供方、打码后的账户 ID、状态，如需要重新认证、速率或配额受限、刷新冲突等），外加可选的 `Action:` 提示。账户 ID 会被脱敏；tokens 和邮箱绝不会打印。`--json` 协议目前不包含这个健康区块。

```bash
ccx status
ccx status --json
```

简化示例结构：

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.codexcommander/config.json",
    "pid": "/Users/example/.codexcommander/codexcommander.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.codexcommander/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

真实对象还会包含 `listen`（端口、主机名、运行时/配置来源）、配置加载诊断，以及 bundled Codex 插件诊断。JSON schema 仅允许追加字段：未来版本可能新增字段，但现有字段应保持稳定。它刻意不包含 API keys、OAuth tokens、授权头、请求内容、邮箱和账户身份。

### `ccx health [--json]`

对正在运行的代理做身份校验。人类可读输出报告 PID/端口；`--json` 输出 `{ok, pid, port}`。只有在健康时该命令才以 0 退出，否则以 1 退出，因此适合用作服务探针。

### `ccx ready [--json] [--wait [--timeout <seconds>]]`

通过无需认证的 `GET /readyz` 端点检查同步后的就绪状态。就绪时返回 `200`；状态为 `pending` 或
终态 `failed` 时返回 `503`，并带有 `Retry-After: 1`。HTTP 仅返回经脱敏的身份字段
`{service, version, uptime, pid, port, status}`。`/healthz` 是独立的存活检查，不是就绪检查。
默认只探测一次；`--wait` 会轮询到就绪或超时，但遇到终态
`failed` 会立即退出。默认超时为 45 秒；`--timeout <seconds>` 必须与 `--wait` 一起使用，取值范围为 1–300 秒的正整数。CLI JSON
输出 `{ready, status, pid, port}`，其中 `status` 为 `ready`、`pending`、`failed` 或
`unreachable`。退出码：就绪为 0；未就绪、pending、failed、超时或无法连接为 1；参数无效为 64。

### `ccx doctor`

运行只读的环境与连通性诊断：状态路径和文件系统类型、WSL 双重安装、代理环境/配置、ChatGPT 可达性，以及 Codex 插件和项目配置警告。Codex app-home 定位部分也会检测狭义的 Windows Orca 运行时 home 不匹配，并在适用时显示手动卸载、环境设置和重新安装步骤。此诊断展示的路径会对操作系统用户名进行脱敏。Doctor 会输出修复提示，但不会自动应用。

**OAuth 可靠性** 部分会报告凭据存储是否可写、是否能够在 `CODEXCOMMANDER_HOME` 下创建刷新 single-flight/锁文件、不健康的 OAuth 或 Codex 池账户（脱敏 ID）及其恢复 `Action:`，并给出一条静态 OK，说明 Codex 转发路径不会伪造官方客户端元数据。Doctor 绝不会修改凭据或执行修复。

:::note[升级后一次性重启]
从旧版本持续运行的代理，其受保护运行时记录中可能没有 `attestationSecret`。在使用 CLI 管理命令或启动会携带凭据的 Claude/OpenCode 客户端之前，请将该代理重启一次。在此之前，敏感请求会 fail closed：token 和 request body 绝不会回退发送到仅通过公开 health 信息或配置端口发现的 listener。
:::

## 目录同步

### `ccx sync [--restart-codex]`

从每个已配置的提供方获取实时模型列表，并将合并后的目录重新注入 Codex。在添加提供方后运行，或用于刷新可用模型。

如果仍有长期运行的 Codex `app-server` 进程，`ccx sync` 会警告它们可能继续提供旧的内存模型列表，即使 `codexcommander-catalog.json` / `models_cache.json` 已更新。传入 `--restart-codex` 会仅向当前用户拥有、匹配 `codex … app-server` 和 `codex-code-mode-host` 的进程发送 `SIGTERM`（当前活跃会话可能会被打断）。故意避免使用宽泛的 `pkill -f codex` 匹配。

普通 `ccx sync` 不会中断工作。同一 app-server 中的新 task 或 fork 不会使其重新加载 catalog。请使用仪表板中的 **Apply agent catalog**、`ccx sync --restart-codex`，或退出并重新打开 Codex Desktop。

### `ccx sync-cache [--restart-codex]`

使 Codex 的本地模型选择器缓存失效，让它根据当前激活的 CodexCommander 目录重新生成。与 `ccx sync` 相同的陈旧 `app-server` 警告和可选 `--restart-codex` 行为同样适用。

## 后台服务

### `ccx service [install|repair|start|stop|status|uninstall|remove]`

将 CodexCommander 作为登录管理的后台服务运行（macOS **launchd**、Linux **systemd user unit**、Windows **Task Scheduler**），在登录时自动启动，在崩溃时自动重启。服务运行会设置 `CCX_SERVICE=1`，因此管理器自动重启时不会反复改动 Codex 配置。显式创建服务以及执行 `install`、`repair` 或 `start` 会启用 Codex 集成，并让 Codex 通过代理路由。

| 子命令 | 操作 |
| --- | --- |
| none | 创建/更新并启动服务。 |
| `install` | 创建并启动服务。 |
| `repair` | 就地刷新已安装的服务并重启，不重新注册。 |
| `start` | 启动已安装的服务。 |
| `stop` | 恢复并验证原生 Codex，再停止服务。如果验证失败，服务和代理会保持运行。 |
| `status` | 报告服务和代理诊断信息及日志路径。 |
| `uninstall` | 恢复并验证原生 Codex，再停止并移除服务。 |
| `remove` | `uninstall` 的别名。 |

```bash
ccx service
ccx service install
ccx service repair
ccx service status
ccx service uninstall
```

在 Windows 上，`ccx service status` 会单独报告 Task Scheduler 注册状态和已身份验证的 CodexCommander 代理可达性。它不会打印本地化的 `schtasks` 表格，因此在不同 Windows 代码页下摘要仍然可读。

在 Windows 上，创建 Task Scheduler 条目需要提升权限。识别到本地化的访问被拒绝文本时，会沿用现有的指导路径。如果该文本不可读，则回退要求命令形态为 `/create /tn codexcommander-proxy /xml <non-empty-path> /f`，状态为 1，并且令牌明确为非提升权限；这时仪表盘的 Startup Safety 操作可以自动请求 UAC。如果该回退无法判断令牌状态，它会保留原始调度器错误。外部任务和操作绝不会发出自动提升标记。请批准仪表盘的 UAC 提示，或在提升权限的 PowerShell 窗口中重新运行 `ccx service install`。

### `ccx codex-shim <install|status|uninstall|remove>`

在 PATH 上把基于脚本的 `codex` 启动器包装为一个轻量自启动脚本。真实的 `codex.exe` 目标会保持不变，以避免破坏精确的可执行文件调用。

如果已完成的外部 Codex 更新覆盖了已安装的 shim，下一次普通的 `ccx` 命令会先备份稳定的新启动器，再在分发前恢复 shim。仍在变动中的启动器会保持不动，并在稍后重试。修复失败只会警告，不会让所请求的命令失败；手动回退：`ccx codex-shim install`。将 `codexShimAutoRestore` 设为 `false`，或设置 `CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE=0`，即可在进程级别关闭自动恢复。

| 子命令 | 操作 |
| --- | --- |
| `install` | 安装 shim（或在过期时修复）。 |
| `uninstall` | 移除 shim 并恢复原始 Codex 二进制。 |
| `remove` | `uninstall` 的别名。 |
| `status` | 报告 shim 状态（已安装、过期或缺失）。 |

```bash
ccx codex-shim install
ccx codex-shim status
ccx codex-shim uninstall
```

:::tip[Service vs Shim]
将 `ccx service` 用于始终在线的后台代理（推荐）。将 `ccx codex-shim` 用于无需守护进程的轻量按需启动——代理只会在启动 `codex` 时运行。
:::

### `ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

安装并控制 Windows 状态托盘图标。它会在 Windows 登录时启动，并提供一键代理控制。`start` 和 `stop` 只控制图标本身；要控制代理，请使用其菜单。`--no-start` 适用于 `install`，会安装托盘但不会立即启动。

## 仪表盘

### `ccx gui`

在 `http://localhost:<port>` 打开 [web dashboard](/guides/web-dashboard/)，如果代理未运行则会自动启动。短期、一次性的浏览器启动票据会解锁更改操作，包括确认后的 **Apply agent catalog**。票据只通过 URL fragment 传递，并在交换过程中清除；长期管理员 token 不会进入 URL 或 Web Storage。确认 session 只存在于进程内存中，最长八小时，且不会续期。到期或代理重启后的下一个 API 请求会返回 `401`；请通过 `ccx gui` 或 macOS 菜单栏应用重新打开。手动打开 loopback 页面不会获得 API session，也绝不会请求或发送长期管理员 token。

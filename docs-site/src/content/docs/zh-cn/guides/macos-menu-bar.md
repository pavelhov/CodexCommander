---
title: macOS 菜单栏伴侣
description: 安装并使用显示 CodexCommander 代理状态、启动就绪状态、Codex 路由、实时请求和提供商配额的原生伴侣。
---

macOS 伴侣会在菜单栏中显示最有用的 CodexCommander 状态，同时不会取代代理或重复实现 Web
控制面板。它是一款原生 Swift/AppKit 应用程序，并且只与同一台 Mac 上运行的 CodexCommander
实例通信。

## 安装

目前没有已发布的 macOS 打包应用。请按照[从源代码构建](#从源代码构建)的步骤从现有检出目录运行。开发应用应保留在 `dist/macos/CodexCommander.app`，不要复制到 Application Support。

## 启动模式

- **Desktop** — 登录时打开菜单栏应用，并连接或启动唯一一个服务器。
- **Headless** — 不打开菜单栏应用，只启动另行安装的 `ccx service`。
- **Off** — 不自动启动；手动打开应用或运行 `ccx start`。

可在启动行切换 **Launch at Login**。如果需要批准，应用会直接打开 macOS Login Items 设置。
此开关不会安装、停止或删除后台服务。

可见应用与后台代理相互独立。当 CodexCommander 面板处于活动状态时，**Quit Menu Bar**（`⌘Q`）只关闭伴侣 UI，并让路由继续运行。
**Stop CodexCommander and Quit…**（`⌥⌘Q`）是明确的破坏性退出操作：确认后先恢复
原生 Codex 路由，再停止代理和服务；只有在确认停止成功后才关闭伴侣。

## 面板显示的内容

- **代理状态** — 显示代理进程是否在运行。服务器正在运行并不能证明启动同步已完成，也不能证明 Codex 正在使用该代理。
- **就绪状态** — 将启动和目录同步显示为 **Checking**、**Starting**、**Ready**、
  **Startup failed** 或 **Unavailable**。该信号与代理运行状态相互独立。
- **Codex 路由** — 显示 Codex 当前是否通过 CodexCommander、原生 OpenAI 或其他自定义路由。
  代理正在运行本身并不表示 Codex 正在使用它。
- **实时代理请求** — 显示当前进行中的请求数量以及模型/提供商 turn 行。只有当 CodexCommander 能够
  根据请求元数据证明其进行中的父请求时，派生的子请求才会嵌套显示；否则，它会显示为独立的
  子智能体 turn。模型请求结束后，即使 Codex 仍将子线程保持为空闲状态以供后续使用，该行也会消失。
  这不是持久的 Codex 智能体生命周期视图；伴侣也绝不会虚构排队中、审阅中、受速率限制或已完成的历史记录。
- **提供商配额** — 在可用时显示提供商报告的 5 小时、每周、每月或特定额度窗口及重置时间。
  OpenCode Go 显示公开上限和本地观测值，不会编造当前余额。缺失数据会显示为不可用，绝不会
  显示为零使用量或无限容量。
- **Dashboard 和 Logs** — 在默认浏览器中打开对应的本地控制面板视图，并为包括目录 Apply 在内的更改操作传递一次性启动授权。
- **管理** — 打开所选提供商的 Accounts 或 API Keys 标签页。OAuth、API 密钥输入、重新认证、
  账户切换和提供商配置仍在控制面板中进行。
- **Restart ChatGPT to load models** — 当正在运行的 Codex 后台工作进程仍持有旧模型列表时显示的
  持久、非致命提示卡片。CodexCommander 代理会保持健康并继续运行。
- **Show restart steps…** — 说明推荐的重新加载边界：完全退出 ChatGPT，重新打开后再开始新任务。
  菜单栏应用不会通过这张卡片强制重启后台工作器。
- **Start Proxy** — 启动或连接代理，启用 Codex 集成，并让 Codex 通过运行中的端点路由。
- **Stop Proxy…** — 始终请求确认，并在停止代理前恢复原生 Codex 路由。如果无法验证原生路由，代理和
  服务会保持运行。菜单栏应用保持打开。
- **Restart Proxy…** — 请求确认，并执行与 CLI 相同的安全停止→启动事务：先恢复原生 Codex 路由，再
  终止旧代理；随后由显式 Start 阶段启动新代理，并让 Codex 重新通过它路由。若重启失败，Codex 会保持原生路由。
- **Restore Native Codex** — 在不停止代理的情况下，把 Codex 切换回原生 OpenAI 路由。
- **Route Codex Through Proxy** — 在不重启代理的情况下，把 Codex 指向已经运行的 CodexCommander 代理。
- **Quit Menu Bar** — 只关闭伴侣 UI；不会停止代理、服务或客户端路由。面板处于活动状态时，这是安全的 `⌘Q` 操作。
- **Stop CodexCommander and Quit…** — 确认中断后先恢复原生 Codex 路由，再停止后台代理和服务，并且
  只在确认停止成功后退出。若停止失败，伴侣会保持打开并显示错误。面板处于活动状态时，快捷键为 `⌥⌘Q`。

选择任一路由操作后，标题下方会立即显示状态卡片。它会显示旋转进度、已用时间和真实处理阶段：
**Changing route** 和 **Confirming route**。操作期间路由和生命周期按钮会被禁用；空闲时，
当前已生效路由对应的按钮会被禁用。进度会一直显示到操作结束，最终成功或错误会保留到你点击
**Dismiss** 或开始另一项操作，不会按定时器自动消失。

**Restore Native Codex** 或 **Route Codex Through Proxy** 成功后，请完全退出 ChatGPT，重新打开后再
开始新任务。此时路由已经保存并确认，但正在运行的 ChatGPT/Codex 主机仍可能保留之前的路由。

原生逃生路径刻意保持狭窄：它只会移除 <code>$CODEX_HOME/config.toml</code> 中带有 CodexCommander
所有权标记的路由，不会更改 Codex 任务、历史记录、身份验证或代理进程，也不需要 `repair` 命令或协调器数据库。
生成的目录和缓存可能仍留在磁盘上，但原生 Codex 不再引用它们。

`codexcommander-journal.json` 是受保护的恢复检查点，而不是另一个路由设置。它用于在中断后区分
CodexCommander 写入的精确配置与用户之后的编辑。如果该检查点仍属于经过证明的运行中代理、profile
证据仍然匹配且受管理路由保持完整，重复执行 **Route Codex Through Proxy** 会成为安全的 no-op。sync
之后对无关 Codex 偏好设置的修改是允许的。如果路由所有权已更改、为 custom、存在歧义或无法安全证明，
CodexCommander 不会猜测，而会保持现有路由不变。请勿手动删除或编辑 journal。

如果 ChatGPT 的配额报告可用，ChatGPT 会排在最前并默认展开。Kimi 和 Grok 显示为折叠摘要。
已配置且支持配额的提供商即使未返回报告也不会从列表中消失；该行会显示**配额不可用**，展开后可进入
提供商设置。如果关联的 Grok 或 Kimi CLI 登录已过期，该行会改为显示**登录需要刷新**，并提示运行
`grok` 或 `kimi`，然后点击**刷新**。被拒绝的登录显示为**需要登录**，网络或上游故障显示为
**暂时不可用**。这些是本地代理返回的固定隐私安全原因代码，不是原始提供商错误。
**查看所有提供商**会打开完整的 Providers 工作区。

## 智能体目录更新

打开应用时，它会自动将 Codex 模型目录与 CodexCommander 当前配置的提供商同步。如果没有 Codex 工作
进程在运行，新列表会在下一个 Codex 任务中生效。如果长时间运行的工作进程载入了旧列表，CodexCommander
仍会继续运行，面板会持续显示非致命的 **Restart ChatGPT to load models** 提示卡片。

选择 **Show restart steps…**，完全退出 ChatGPT，重新打开后再开始新任务。这是替换旧工作器时推荐且
最可预测的方式。CodexCommander 和菜单栏应用在此期间会继续运行。

在同一个旧后台主机中启动新 task 或 fork 并不是 catalog 重新加载边界，因此卡片会一直保留，直到
状态检查发现工作器已是最新。如果仪表盘显示 catalog 为 pending 或 unknown，或者受管理路由尚未注入，
请先在那里选择**应用到 Codex**，让它协调并验证这些文件；仅退出 ChatGPT 并不能完成这项修复。

对于 catalog 已经协调、只有工作器过时的情况，仪表盘/API 的**强制重启工作器**操作和 CLI
仍是高级备用方案。它们会再次同步，使用目标修订围栏，只向当前用户所有、精确匹配
`codex … app-server` 和 `codex-code-mode-host` 的进程发送信号，并且绝不会升级为宽泛的 `pkill`。
由于这会绕过 ChatGPT 的正常应用生命周期，ChatGPT 可能显示 **stopped unexpectedly**。CLI 形式为：

```bash
ccx sync --restart-codex
```

## 身份验证与隐私

伴侣不会创建另一套登录系统，不使用 macOS Keychain，也不会从中读取提供商凭据。

当前 CodexCommander 版本会在 <code>~/.codexcommander/admin-api-token</code>（或
<code>$CODEXCOMMANDER_HOME/admin-api-token</code>）生成独立的管理凭据。伴侣通过经过验证且不跟随
符号链接的文件描述符读取这个现有文件，仅将其值保留在进程内存中，并且只发送给经过身份
验证的回环 CodexCommander 进程。它绝不会显示、记录、复制或存储该令牌，也不会将其放入浏览器
URL。

伴侣打开仪表盘时，会向经过验证的本地代理请求一个短期、一次性启动票据。票据只出现在 URL fragment 中，并在一次性交换过程中清除；长期管理员 token 不会进入 URL 或 Web Storage。确认的完整功能 session 只存在于进程内存中，最长八小时，且不会续期。到期或代理重启后的下一个 API 请求会返回 `401`，页面会提示通过伴侣或 `ccx gui` 重新打开。手动打开的 loopback 仪表盘没有 API session，也绝不会请求或发送长期管理员 token。

提供商凭据仍由 CodexCommander 管理。伴侣绝不会读取 ChatGPT、Kimi、Grok、Anthropic 或其他
提供商令牌，也绝不会直接调用提供商登录端点。

仅配置 <code>CODEXCOMMANDER_ADMIN_AUTH_TOKEN</code> 的安装，在应用进程继承该变量时可以工作。
从 Finder 启动的应用通常不会继承 shell 变量；如果没有受保护的令牌文件，伴侣会报告管理
身份验证不可用，而不会显示令牌输入表单。

实时请求记录仅保存在内存中。管理响应包含仅在进程生命周期内有效的行 ID、提供商/模型
标识符、时间戳和汇总计数。它不包含提示词、标题、工作目录、工具参数、账户标识符、凭据、
请求正文、原始线程/会话 ID 或历史活动。

## 轮询

面板打开时，应用会频繁刷新轻量级的进行中请求信息；面板关闭时则会降低频率。提供商配额按独立且
更慢的节奏刷新，并使用 CodexCommander 报告的上游时间戳。重复失败会自动退避，重叠的刷新会被
合并。

使用**刷新**可立即刷新进行中的请求并强制刷新配额。

## 从源代码构建

需要 macOS 13 或更高版本以及 Xcode Command Line Tools。构建 Intel + Apple silicon 通用版本需要完整的 Xcode。

```bash
cd /path/to/CodexCommander
bun install
bun run test:macos
bun run build:macos
open dist/macos/CodexCommander.app
```

开发应用的唯一位置是 `dist/macos/CodexCommander.app`。每次构建都会把 Bun 运行时和 CodexCommander
服务器资源嵌入应用包；运行中的应用不会直接执行检出目录里的 `src/`。源代码发生变化后请重新构建
应用。开发期间请保留在此位置，不要复制到 Application Support。双击会尝试确保代理运行；即使离线
或启动失败，应用也不会关闭，面板和 **Start** 控件仍可使用。
每次构建都会把准确的 Git 修订写入应用包 `Info.plist` 的 `CodexCommanderSourceRevision`，并在构建结束时
输出。未提交的源码会带有 `-dirty`，因此制作最终包前请先提交。

## 故障排除

- **代理不可用** — 使用 <code>ccx start</code> 启动，或使用
  <code>ccx service install</code> 安装后台服务。
- **身份验证不可用** — 运行 <code>ccx doctor</code>；确认 CodexCommander 状态目录和
  <code>admin-api-token</code> 归你的用户所有，并且组用户和其他用户无法访问。
- **配额不可用** — 打开该提供商的**管理**目标，然后连接或重新认证账户。部分提供商不公开
  配额 API。如果 Grok 显示**登录需要刷新**，请运行 <code>grok</code> 完成登录，然后在 CodexCommander
  中点击**刷新**；Kimi 的对应操作使用 <code>kimi</code>。
- **重启后未恢复** — 打开 **Logs** 并运行 <code>ccx status</code>。伴侣绝不会将终止进程或重写
  服务状态作为回退措施。
- **停止、Codex 更新或冷启动后只显示原生模型** — 重新打开 CodexCommander。启动时会自动同步目录；即使
  提供商发现暂时为空，CodexCommander 也会从受保护的最近正常目录中恢复仍在配置中的路由模型。如果
  **Restart ChatGPT to load models** 仍然显示，请退出并重新打开 ChatGPT，然后开始新任务。只有在手动
  重启不合适时，才使用[智能体目录更新](#智能体目录更新)中的高级仪表盘/API 或 CLI 备用方案。

## 卸载

关闭 **Launch at Login**，退出伴侣，然后将 <code>CodexCommander.app</code> 移到废纸篓。它不存储
提供商凭据，也不创建 Keychain 条目。卸载伴侣不会停止或卸载 CodexCommander 代理；只有在也要删除
无界面服务时，才需另行运行 <code>ccx service uninstall</code>。

---
title: macOS 菜单栏伴侣
description: 安装并使用原生 OpenCodex 状态、智能体活动和提供商配额伴侣。
---

macOS 伴侣会在菜单栏中显示最有用的 OpenCodex 状态，同时不会取代代理或重复实现 Web
控制面板。它是一款原生 Swift/AppKit 应用程序，并且只与同一台 Mac 上运行的 OpenCodex
实例通信。

## 安装

1. 从对应的 GitHub 发行版下载 <code>OpenCodex-&lt;version&gt;-macos-universal.zip</code> 及其
   <code>.sha256</code> 文件。
2. 验证归档文件：

       shasum -a 256 -c OpenCodex-<version>-macos-universal.zip.sha256

3. 解压，然后将 <code>OpenCodex.app</code> 移到**应用程序**。
4. 打开该应用。应用已包含 Bun 运行时、代理、生产依赖和仪表板资源，因此无需另行安装 npm、Bun 或
   <code>ocx</code>。其图标会出现在菜单栏中；它不会添加 Dock 图标。从稳定位置首次启动时会启用
   **Launch at Login**。

内置运行时继续使用现有用户状态 <code>~/.opencodex</code> 和 <code>~/.codex</code>，不会将凭据复制到
应用包或 Keychain。提供商 OAuth 和 API 密钥仍在本地仪表板中配置。

在发行版使用 Developer ID 签名并完成公证之前，macOS 可能会阻止首次启动下载的应用。按住
Control 键点按该应用，选择**打开**，然后确认**打开**。本地构建不会带有下载文件的隔离属性。

内置运行时为只读。更新时应替换为最新签名的 <code>OpenCodex.app</code>；npm、Bun 或源码更新不会
修改已签名的 <code>Contents/Resources</code>。

## 启动模式

- **Desktop** — 登录时打开菜单栏应用，并连接或启动唯一一个服务器。
- **Headless** — 不打开菜单栏应用，只启动另行安装的 `ocx service`。
- **Off** — 不自动启动；手动打开应用或运行 `ocx start`。

可在启动行切换 **Launch at Login**。如果需要批准，应用会直接打开 macOS Login Items 设置。
此开关不会安装、停止或删除后台服务。

可见应用与后台代理相互独立。当 OpenCodex 面板处于活动状态时，**Quit Menu Bar**（`⌘Q`）只关闭伴侣 UI，并让路由继续运行。
**Stop OpenCodex and Quit…**（`⌥⌘Q`）是明确的破坏性退出操作：确认后停止代理和服务、恢复
原生 Codex 路由，并且只有在确认停止成功后才关闭伴侣。

## 面板显示的内容

- **智能体活动** — 当前活动数量以及实时模型/提供商行。只有当 OpenCodex 能够根据请求元数据
  证明其活动父项时，派生的子项才会嵌套显示；否则，它会显示为独立的子智能体。伴侣绝不会
  虚构排队中、审阅中、受速率限制或已完成的历史记录。
- **提供商配额** — 在可用时显示提供商报告的 5 小时、每周、每月或特定额度窗口及重置时间。
  OpenCode Go 显示公开上限和本地观测值，不会编造当前余额。缺失数据会显示为不可用，绝不会
  显示为零使用量或无限容量。
- **Dashboard 和 Logs** — 在默认浏览器中打开对应的本地控制面板视图。
- **管理** — 打开所选提供商的 Accounts 或 API Keys 标签页。OAuth、API 密钥输入、重新认证、
  账户切换和提供商配置仍在控制面板中进行。
- **Agent catalog update ready** — 当正在运行的 Codex 后台工作进程仍持有旧模型列表时显示的
  持久、非故障卡片。OpenCodex 代理会保持健康并继续运行。
- **Apply agent catalog…** — 打开确认窗口，在可用时显示最新请求活动，警告应用更新可能中断
  回答，并提供 **Apply Now** 和 **Later**。
- **Stop Proxy…** — 始终请求确认，会中断活动客户端和子智能体请求、恢复原生 Codex，并让菜单栏应用保持打开。
- **Restart Proxy…** — 请求确认，允许代理用最多 60 秒排空活动请求，然后重新连接到替代进程。接受重启
  请求不会被显示为完成；应用会等待新进程通过身份检查。
- **Quit Menu Bar** — 只关闭伴侣 UI；不会停止代理、服务或客户端路由。面板处于活动状态时，这是安全的 `⌘Q` 操作。
- **Stop OpenCodex and Quit…** — 确认中断后停止后台代理和服务、恢复原生 Codex 路由，并且只在
  确认停止成功后退出。若停止失败，伴侣会保持打开并显示错误。面板处于活动状态时，快捷键为 `⌥⌘Q`。

如果 ChatGPT 的配额报告可用，ChatGPT 会排在最前并默认展开。Kimi 和 Grok 显示为折叠摘要。
已配置且支持配额的提供商即使未返回报告也不会从列表中消失；该行会显示**配额不可用**，展开后可进入
提供商设置。如果关联的 Grok 或 Kimi CLI 登录已过期，该行会改为显示**登录需要刷新**，并提示运行
`grok` 或 `kimi`，然后点击**刷新**。被拒绝的登录显示为**需要登录**，网络或上游故障显示为
**暂时不可用**。这些是本地代理返回的固定隐私安全原因代码，不是原始提供商错误。
**查看所有提供商**会打开完整的 Providers 工作区。

## 智能体目录更新

打开应用时，它会自动将 Codex 模型目录与 OpenCodex 当前配置的提供商同步。如果没有 Codex 工作
进程在运行，新列表会在下一个 Codex 任务中生效。如果长时间运行的工作进程载入了旧列表，OpenCodex
仍会继续运行，面板会持续显示非故障的 **Agent catalog update ready** 卡片。

选择 **Apply agent catalog…** 可查看中断风险。确认前会尽可能获取最新的活动请求数量，但请求数为
零不会被描述为 Codex 已空闲的证明，因为操作执行前仍可能开始新请求。**Apply Now** 会再次同步，
仅向当前用户所有、精确匹配 `codex … app-server` 和 `codex-code-mode-host` 的进程发送 `SIGTERM`，并
短暂验证旧进程 ID 已退出。它不会使用宽泛的 `pkill`，不会重启 OpenCodex 代理，也不会关闭菜单栏
应用。Codex 会在下一个任务中创建新的后台主机并载入当前列表。

此发行版不包含 **Apply when idle**。如果回答仍在进行，请选择 **Later**，并在准备好后应用更新；
卡片会继续保留。高级 CLI 回退命令如下：

```bash
ocx sync --restart-codex
```

## 身份验证与隐私

伴侣不会创建另一套登录系统，也不会迁移到 macOS Keychain 或从中读取提供商凭据。

当前 OpenCodex 版本会在 <code>~/.opencodex/admin-api-token</code>（或
<code>$OPENCODEX_HOME/admin-api-token</code>）生成独立的管理凭据。伴侣通过经过验证且不跟随
符号链接的文件描述符读取这个现有文件，仅将其值保留在进程内存中，并且只发送给经过身份
验证的回环 OpenCodex 进程。它绝不会显示、记录、复制或存储该令牌，也不会将其放入浏览器
URL。

提供商凭据仍由 OpenCodex 管理。伴侣绝不会读取 ChatGPT、Kimi、Grok、Anthropic 或其他
提供商令牌，也绝不会直接调用提供商登录端点。

仅配置 <code>OPENCODEX_ADMIN_AUTH_TOKEN</code> 的安装，在应用进程继承该变量时可以工作。
从 Finder 启动的应用通常不会继承 shell 变量；如果没有受保护的令牌文件，伴侣会报告管理
身份验证不可用，而不会显示令牌输入表单。

实时智能体记录仅保存在内存中。管理响应包含仅在进程生命周期内有效的行 ID、提供商/模型
标识符、时间戳和汇总计数。它不包含提示词、标题、工作目录、工具参数、账户标识符、凭据、
请求正文、原始线程/会话 ID 或历史活动。

## 轮询

面板打开时，应用会频繁刷新轻量级活动信息；面板关闭时则会降低频率。提供商配额按独立且
更慢的节奏刷新，并使用 OpenCodex 报告的上游时间戳。重复失败会自动退避，重叠的刷新会被
合并。

使用**刷新**可立即刷新活动信息并强制刷新配额。

## 从源代码构建

需要 macOS 13 或更高版本以及 Xcode Command Line Tools。构建 Intel + Apple silicon 通用
发行版需要完整的 Xcode。

```bash
git clone https://github.com/pavelhov/opencodex.git
cd opencodex
bun install
bun run test:macos
bun run build:macos
open dist/macos/OpenCodex.app
```

源码应用的唯一位置是 `dist/macos/OpenCodex.app`。它使用同一检出中的 Bun 和 CLI，因此需要先运行
`bun install`。开发期间请保留在此位置，不要复制到 Application Support。双击会尝试确保代理运行；
即使离线或启动失败，应用也不会关闭，面板和 **Start** 控件仍可使用。
每次构建都会把准确的 Git 修订写入应用包 `Info.plist` 的 `OpenCodexSourceRevision`，并在构建结束时
输出。未提交的源码会带有 `-dirty`，因此制作最终分发包前请先提交。

## 故障排除

- **代理不可用** — 使用 <code>ocx start</code> 启动，或使用
  <code>ocx service install</code> 安装后台服务。
- **身份验证不可用** — 运行 <code>ocx doctor</code>；确认 OpenCodex 状态目录和
  <code>admin-api-token</code> 归你的用户所有，并且组用户和其他用户无法访问。
- **配额不可用** — 打开该提供商的**管理**目标，然后连接或重新认证账户。部分提供商不公开
  配额 API。如果 Grok 显示**登录需要刷新**，请运行 <code>grok</code> 完成登录，然后在 OpenCodex
  中点击**刷新**；Kimi 的对应操作使用 <code>kimi</code>。
- **重启后未恢复** — 打开 **Logs** 并运行 <code>ocx status</code>。伴侣绝不会将终止进程或重写
  服务状态作为回退措施。
- **停止、更新或冷启动后只显示原生模型** — 重新打开 OpenCodex。启动时会自动同步目录；即使
  提供商发现暂时为空，OpenCodex 也会从受保护的最近正常目录中恢复仍在配置中的路由模型。如果
  **Agent catalog update ready** 仍然显示，请选择 **Apply agent catalog…**，或使用
  [智能体目录更新](#智能体目录更新)中的 CLI 回退命令。

## 卸载

关闭 **Launch at Login**，退出伴侣，然后将 <code>OpenCodex.app</code> 移到废纸篓。它不存储
提供商凭据，也不创建 Keychain 条目。卸载伴侣不会停止或卸载 OpenCodex 代理；只有在也要删除
无界面服务时，才需另行运行 <code>ocx service uninstall</code>。

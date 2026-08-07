---
title: macOS 菜单栏伴侣
description: 安装并使用原生 OpenCodex 状态、智能体活动和提供商配额伴侣。
---

macOS 伴侣会在菜单栏中显示最有用的 OpenCodex 状态，同时不会取代代理或重复实现 Web
控制面板。它是一款原生 Swift/AppKit 应用程序，并且只与同一台 Mac 上运行的 OpenCodex
实例通信。

## 安装

1. 按照常规方式安装并启动 OpenCodex。
2. 从对应的 GitHub 发行版下载 <code>OpenCodex-&lt;version&gt;-macos-universal.zip</code> 及其
   <code>.sha256</code> 文件。
3. 验证归档文件：

       shasum -a 256 -c OpenCodex-<version>-macos-universal.zip.sha256

4. 解压，然后将 <code>OpenCodex.app</code> 移到**应用程序**。
5. 打开该应用。其图标会出现在菜单栏中；它不会添加 Dock 图标。从稳定位置首次启动时会启用
   **Launch at Login**。

在发行版使用 Developer ID 签名并完成公证之前，macOS 可能会阻止首次启动下载的应用。按住
Control 键点按该应用，选择**打开**，然后确认**打开**。本地构建不会带有下载文件的隔离属性。

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
- **Stop Proxy…** — 始终请求确认，会中断活动客户端和子智能体请求、恢复原生 Codex，并让菜单栏应用保持打开。
- **Restart Proxy…** — 请求确认，允许代理用最多 60 秒排空活动请求，然后重新连接到替代进程。接受重启
  请求不会被显示为完成；应用会等待新进程通过身份检查。
- **Quit Menu Bar** — 只关闭伴侣 UI；不会停止代理、服务或客户端路由。面板处于活动状态时，这是安全的 `⌘Q` 操作。
- **Stop OpenCodex and Quit…** — 确认中断后停止后台代理和服务、恢复原生 Codex 路由，并且只在
  确认停止成功后退出。若停止失败，伴侣会保持打开并显示错误。面板处于活动状态时，快捷键为 `⌥⌘Q`。

如果 ChatGPT 的配额报告可用，ChatGPT 会排在最前并默认展开。Kimi 和 Grok 显示为折叠摘要。
已配置且支持配额的提供商即使未返回报告也不会从列表中消失；该行会显示**配额不可用**，展开后可进入
提供商设置。**查看所有提供商**会打开完整的 Providers 工作区。

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

## 故障排除

- **代理不可用** — 使用 <code>ocx start</code> 启动，或使用
  <code>ocx service install</code> 安装后台服务。
- **身份验证不可用** — 运行 <code>ocx doctor</code>；确认 OpenCodex 状态目录和
  <code>admin-api-token</code> 归你的用户所有，并且组用户和其他用户无法访问。
- **配额不可用** — 打开该提供商的**管理**目标，然后连接或重新认证账户。部分提供商不公开
  配额 API。
- **重启后未恢复** — 打开 **Logs** 并运行 <code>ocx status</code>。伴侣绝不会将终止进程或重写
  服务状态作为回退措施。

## 卸载

关闭 **Launch at Login**，退出伴侣，然后将 <code>OpenCodex.app</code> 移到废纸篓。它不存储
提供商凭据，也不创建 Keychain 条目。卸载伴侣不会停止或卸载 OpenCodex 代理；只有在也要删除
无界面服务时，才需另行运行 <code>ocx service uninstall</code>。

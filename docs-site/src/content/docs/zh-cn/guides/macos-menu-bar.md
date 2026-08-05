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
5. 打开该应用。其图标会出现在菜单栏中；它不会添加 Dock 图标。

在发行版使用 Developer ID 签名并完成公证之前，macOS 可能会阻止首次启动下载的应用。按住
Control 键点按该应用，选择**打开**，然后确认**打开**。本地构建不会带有下载文件的隔离属性。

## 面板显示的内容

- **智能体活动** — 当前活动数量以及实时模型/提供商行。只有当 OpenCodex 能够根据请求元数据
  证明其活动父项时，派生的子项才会嵌套显示；否则，它会显示为独立的子智能体。伴侣绝不会
  虚构排队中、审阅中、受速率限制或已完成的历史记录。
- **提供商配额** — OpenCodex 返回的每个真实 5 小时、每周、每月或提供商特定的额度窗口，
  包括重置时间。缺失数据会显示为不可用，绝不会显示为零使用量或无限容量。
- **Dashboard 和 Logs** — 在默认浏览器中打开对应的本地控制面板视图。
- **管理** — 打开所选提供商的 Accounts 或 API Keys 标签页。OAuth、API 密钥输入、重新认证、
  账户切换和提供商配置仍在控制面板中进行。
- **重启** — 请求确认，允许代理用最多 60 秒排空活动请求，然后重新连接到替代进程。接受重启
  请求不会被显示为完成；应用会等待新进程通过身份检查。

如果 ChatGPT 的配额报告可用，ChatGPT 会排在最前并默认展开。Kimi 和 Grok 显示为折叠摘要。
**查看所有提供商**会打开完整的 Providers 工作区。

## 身份验证与隐私

伴侣不会创建另一套登录系统，也不使用 macOS Keychain。

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

    git clone https://github.com/pavelhov/opencodex.git
    cd opencodex
    npm run test:macos
    npm run build:macos
    open dist/macos/OpenCodex.app

这两个脚本会直接调用 Swift，因此无需安装 npm 依赖。

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

退出伴侣，然后将 <code>OpenCodex.app</code> 移到废纸篓。它不存储提供商凭据，也不创建 Keychain
条目。卸载伴侣不会停止或卸载 OpenCodex 代理。

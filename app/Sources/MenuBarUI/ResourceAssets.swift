import AppKit
import Foundation
import MenuBarCore

/// Loads brand and provider artwork from the packaged bundle, with a repo-relative
/// fallback for `swift run` during development. Never synthesizes fake logos.
public enum ResourceAssets {
    private static let iconAliases: [String: String] = [
        "anthropic": "claude-color.svg",
        "anthropic-apikey": "claude-color.svg",
        "azure-openai": "openai.svg",
        "chatgpt": "openai.svg",
        "cloudflare-ai-gateway": "cloudflare-ai-gateway-color.svg",
        "cloudflare-workers-ai": "cloudflare-ai-gateway-color.svg",
        "cursor": "cursor-color.svg",
        "deepseek": "deepseek-color.svg",
        "firepass": "firepass-color.svg",
        "fireworks": "fireworks-color.svg",
        "github": "github-copilot-color.svg",
        "github-copilot": "copilot-color.svg",
        "gitlab-duo": "gitlab-duo-color.svg",
        "google": "gemini-color.svg",
        "google-antigravity": "antigravity-color.svg",
        "google-vertex": "gemini-color.svg",
        "groq": "groq-color.svg",
        "huggingface": "huggingface-color.svg",
        "kimi": "kimi-color.svg",
        "kimi-code": "kimi-color.svg",
        "kiro": "kiro-color.svg",
        "lm-studio": "lm-studio-color.svg",
        "mistral": "mistral-color.svg",
        "moonshot": "moonshot-color.svg",
        "nvidia": "nvidia-color.svg",
        "ollama": "ollama-color.svg",
        "ollama-cloud": "ollama-color.svg",
        "openai": "openai.svg",
        "openai-apikey": "openai.svg",
        "opencode-free": "opencode.svg",
        "opencode-go": "opencode.svg",
        "opencode-zen": "opencode.svg",
        "openrouter": "openrouter-color.svg",
        "qianfan": "qianfan-color.svg",
        "alibaba": "alibaba-color.svg",
        "alibaba-token-plan": "alibaba-color.svg",
        "alibaba-token-plan-intl": "alibaba-color.svg",
        "qwen-cloud": "qwen-portal-color.svg",
        "vercel-ai-gateway": "vercel-ai-gateway-color.svg",
        "vllm": "vllm-color.svg",
        "xai": "grok-color.svg",
        "mimo-free": "xiaomi-color.svg",
        "xiaomi": "xiaomi-color.svg",
    ]

    private static let displayNames: [String: String] = [
        "chatgpt": "ChatGPT",
        "openai": "ChatGPT",
        "openai-apikey": "OpenAI API",
        "kimi": "Kimi",
        "kimi-code": "Kimi",
        "xai": "Grok",
        "anthropic": "Anthropic",
        "anthropic-apikey": "Anthropic",
        "deepseek": "DeepSeek",
        "google": "Google",
        "google-antigravity": "Antigravity",
        "cursor": "Cursor",
        "ollama": "Ollama",
        "ollama-cloud": "Ollama Cloud",
    ]

    public static func brandImage(size: NSSize = NSSize(width: 22, height: 22)) -> NSImage {
        if let image = loadImage(named: "OpenCodex.png", subdir: nil)
            ?? loadImage(named: "logo.png", subdir: nil, repoRelative: "gui/public/logo.png")
            ?? loadImage(named: "favicon.png", subdir: nil, repoRelative: "gui/public/favicon.png") {
            return resized(image, to: size)
        }
        return NSImage(
            systemSymbolName: "terminal",
            accessibilityDescription: "OpenCodex"
        ) ?? NSImage(size: size)
    }

    public static func providerIcon(for provider: String, size: NSSize = NSSize(width: 16, height: 16)) -> NSImage? {
        let key = provider.lowercased()
        guard let file = iconAliases[key] else { return nil }
        guard let image = loadImage(
            named: file,
            subdir: "provider-icons",
            repoRelative: "gui/public/provider-icons/\(file)"
        ) else { return nil }
        let result = resized(image, to: size)
        result.isTemplate = true
        return result
    }

    public static func providerDisplayName(_ provider: String, label: String?) -> String {
        let key = provider.lowercased()
        if key == "openai" || key == "chatgpt" { return "ChatGPT" }
        if key == "openai-apikey" { return "OpenAI API" }
        if let label, !label.isEmpty { return label }
        if let known = displayNames[key] { return known }
        if provider == key, provider.contains("-") {
            return provider.split(separator: "-").map { part in
                part.prefix(1).uppercased() + part.dropFirst()
            }.joined(separator: " ")
        }
        return provider
    }

    /// Known providers whose dashboard detail exposes an Accounts tab.
    public static func supportsAccountsTab(
        _ provider: String,
        summary: ProviderSummary? = nil
    ) -> Bool {
        switch provider.lowercased() {
        case "openai", "chatgpt", "anthropic", "kimi", "kimi-code", "xai", "google", "google-antigravity", "cursor":
            return true
        default:
            break
        }

        // Runtime-configured providers cannot all live in a hard-coded list. Mirror the
        // dashboard's auth-surface decision with the safe fields /api/providers already
        // returns, so API-key and OAuth providers deep-link directly to their setup tab.
        switch summary?.authMode?.lowercased() {
        case "key", "oauth":
            return true
        case "forward", "local":
            return false
        default:
            return summary?.hasApiKey == true
        }
    }

    private static func loadImage(
        named name: String,
        subdir: String?,
        repoRelative: String? = nil
    ) -> NSImage? {
        if let url = bundleURL(named: name, subdir: subdir),
           let image = NSImage(contentsOf: url) {
            return image
        }
        if let repoRelative,
           let url = repoURL(relative: repoRelative),
           let image = NSImage(contentsOf: url) {
            return image
        }
        // Common swift-run fallbacks when callers pass only the filename.
        if subdir == nil {
            if let url = repoURL(relative: "gui/public/\(name)"),
               let image = NSImage(contentsOf: url) {
                return image
            }
        } else if subdir == "provider-icons" {
            if let url = repoURL(relative: "gui/public/provider-icons/\(name)"),
               let image = NSImage(contentsOf: url) {
                return image
            }
        }
        return nil
    }

    private static func bundleURL(named name: String, subdir: String?) -> URL? {
        let bundle = Bundle.main
        if let subdir {
            if let url = bundle.url(forResource: name, withExtension: nil, subdirectory: subdir) {
                return url
            }
            if let root = bundle.resourceURL?
                .appendingPathComponent(subdir, isDirectory: true)
                .appendingPathComponent(name) {
                if FileManager.default.fileExists(atPath: root.path) { return root }
            }
        } else {
            if let url = bundle.url(forResource: (name as NSString).deletingPathExtension,
                                    withExtension: (name as NSString).pathExtension) {
                return url
            }
            if let url = bundle.url(forResource: name, withExtension: nil) {
                return url
            }
            if let root = bundle.resourceURL?.appendingPathComponent(name),
               FileManager.default.fileExists(atPath: root.path) {
                return root
            }
        }
        return nil
    }

    private static func repoURL(relative: String) -> URL? {
        var candidates: [URL] = []
        // Source-relative: .../app/Sources/MenuBarUI -> repo root.
        let thisFile = URL(fileURLWithPath: #filePath)
        candidates.append(
            thisFile
                .deletingLastPathComponent() // MenuBarUI
                .deletingLastPathComponent() // Sources
                .deletingLastPathComponent() // app
                .deletingLastPathComponent() // repo
        )
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".."))
        if let env = ProcessInfo.processInfo.environment["OPENCODEX_ROOT"], !env.isEmpty {
            candidates.append(URL(fileURLWithPath: env))
        }
        for root in candidates {
            let url = root.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    private static func resized(_ image: NSImage, to size: NSSize) -> NSImage {
        let result = NSImage(size: size)
        result.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(
            in: NSRect(origin: .zero, size: size),
            from: NSRect(origin: .zero, size: image.size),
            operation: .sourceOver,
            fraction: 1
        )
        result.unlockFocus()
        return result
    }
}

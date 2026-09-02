// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  base: "/",
  trailingSlash: "ignore",
  // lightningcss merges animation-timeline into the `animation` shorthand,
  // which Chrome cannot parse — the scroll-driven animations die silently.
  vite: { build: { cssMinify: "esbuild" } },
  integrations: [
    starlight({
      title: "CodexCommander",
      description:
        "Universal provider proxy for OpenAI Codex & Claude Code — use any LLM with Codex CLI, App, SDK, and Claude Code.",
      tagline: "Use any LLM with OpenAI Codex and Claude Code.",
      logo: {
        light: "./src/assets/logo-light.png",
        dark: "./src/assets/logo-dark.png",
        replacesTitle: false,
      },
      favicon: "/favicon.ico",
      customCss: [
        "@fontsource-variable/geist",
        "./src/styles/custom.css",
      ],
      components: {
        Header: "./src/components/Header.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      head: [
        // Google favicon guidelines: PNG at a multiple of 48px, exposed via rel="icon".
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "192x192", href: "/favicon.png" } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#212121" } },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/pavelhov/CodexCommander" },
      ],
      editLink: {
        baseUrl: "https://github.com/pavelhov/CodexCommander/edit/main/docs-site/",
      },
      lastUpdated: true,
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
            { label: "How It Works", slug: "getting-started/how-it-works" },
            { label: "Agent Quickstart", slug: "getting-started/for-agents" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Providers", slug: "guides/providers" },
            { label: "Model Routing", slug: "guides/model-routing" },
            { label: "Codex Integration", slug: "guides/codex-integration" },
            { label: "Codex App Model Picker", slug: "guides/codex-app-models" },
            { label: "Model Ordering", slug: "guides/model-ordering" },
            { label: "Combos", slug: "guides/combos" },
            { label: "Claude Code", slug: "guides/claude-code" },
            { label: "Grok Build", slug: "guides/grok-build" },
            { label: "opencode", slug: "guides/opencode" },
            { label: "Pi", slug: "guides/pi" },
            { label: "Integrations", slug: "guides/integrations" },
            { label: "Sidecars: Web Search & Vision", slug: "guides/sidecars" },
            { label: "Web Dashboard", slug: "guides/web-dashboard" },
            { label: "macOS Menu Bar", slug: "guides/macos-menu-bar" },
            { label: "Sub-agent Surface", slug: "guides/sub-agent-surface" },
          ],
        },
        {
          label: "Benchmarks",
          collapsed: true,
          items: [
            { label: "Overview", slug: "benchmarks" },
            { label: "Coding", slug: "benchmarks/coding" },
            { label: "Frontend", slug: "benchmarks/frontend" },
            { label: "Terminal", slug: "benchmarks/terminal" },
            { label: "Security", slug: "benchmarks/security" },
            { label: "Intelligence", slug: "benchmarks/intelligence" },
          ],
        },
        {
          label: "Reference",
          items: [
            {
              label: "CLI",
              items: [
                { label: "Overview", slug: "reference/cli" },
                { label: "Lifecycle & Service", slug: "reference/cli/lifecycle" },
                { label: "Providers, Accounts & Models", slug: "reference/cli/providers-accounts" },
                { label: "Agents, Routing & Integrations", slug: "reference/cli/agents" },
              ],
            },
            {
              label: "Configuration",
              items: [
                { label: "Overview", slug: "reference/configuration" },
                { label: "Providers", slug: "reference/configuration/providers" },
                { label: "Routing", slug: "reference/configuration/routing" },
                { label: "Agents", slug: "reference/configuration/agents" },
                { label: "Server & Runtime", slug: "reference/configuration/server" },
              ],
            },
            { label: "Adapters", slug: "reference/adapters" },
            { label: "Architecture", slug: "reference/architecture" },
            { label: "Proxy API Formats", slug: "reference/proxy-formats" },
            { label: "Management API", slug: "reference/management-api" },
          ],
        },
        {
          label: "Troubleshooting",
          collapsed: true,
          items: [
            { label: "Windows Memory Growth", slug: "troubleshooting/windows-memory" },
          ],
        },
        { label: "Contributing", slug: "contributing" },
      ],
    }),
  ],
});

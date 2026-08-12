---
title: インストール
description: CodexCommander(ccx)プロキシと前提条件をインストールし、正常に実行できるか確認します。
---

パッケージ済みまたはローカルリンクされたビルドでは、`ccx` と `codexcommander` の 2 つの同等なコマンドが提供されます。
どちらも Bun ベースの小さなローカル HTTP サーバーを実行します。モデルリクエストはルーティングで選ばれたプロバイダーに
転送され、必要に応じて vision とウェブ検索のサイドカーが ChatGPT ログインを使うこともあります。

## 前提条件

| 要件 | 理由 |
 --- | --- |
| **[Bun](https://bun.sh)** | ソースランタイムとリポジトリのスクリプトは Bun で直接実行されます。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App、または SDK) | CodexCommander が前に立つクライアントです。CodexCommander は `$CODEX_HOME/config.toml`(デフォルト `~/.codex/config.toml`)に書き込みます。 |
| プロバイダーアカウントまたは API キー | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API キー、OpenAI 互換エンドポイント、または ChatGPT ログイン。 |

## ソースチェックアウトを実行

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start
```

レジストリパッケージは現在公開されていません。このチェックアウトでは、`ccx <args>` を
`bun run src/cli/index.ts <args>` に置き換えて実行します。別のターミナルでランタイムを確認します:

```bash
bun run src/cli/index.ts --version
```

## 開発モード

UI を編集するときはプロキシとダッシュボードを別々に実行します:

```bash
bun run dev:proxy   # 開発モードでプロキシ API を起動 (src/cli/index.ts start)
bun run dev:gui     # ダッシュボード dev サーバーを起動 (別ターミナル)
```

`bun run dev` は `bun run dev:proxy` のエイリアスです。プロキシ API は `/healthz`、
`/v1/responses`、`/api/*` を公開し、`GET /` は `bun run build:gui` が `gui/dist` を生成した
後にのみパッケージされたダッシュボードを提供します。ダッシュボードを編集する際は `bun run dev:gui` でフロントエンドを
別途実行してください。macOS コンパニオンは同じチェックアウトから `bun run test:macos && bun run build:macos` でビルドでき、ソースビルドは `dist/macos/CodexCommander.app` に生成されます。

## 生成されるもの

CodexCommander の状態ファイルは `$CODEXCOMMANDER_HOME`(デフォルト `~/.codexcommander`)の下に、Codex 連携ファイルは
`$CODEX_HOME`(デフォルト `~/.codex`)の下に保存されます。

| パス | 用途 |
 --- | --- |
| `$CODEXCOMMANDER_HOME/config.json` | プロバイダー、デフォルトプロバイダー、ポート、オプション。 |
| `$CODEXCOMMANDER_HOME/codexcommander.pid` | 実行中のプロキシの PID(単一インスタンスガード)。 |
| `$CODEXCOMMANDER_HOME/runtime-port.json` | 自動で選んだ代替ポートを含む現在の PID、ホスト名、ポート。 |
| `$CODEXCOMMANDER_HOME/auth.json` | 保存された OAuth 認証情報(`ccx login` 時)。 |
| `$CODEXCOMMANDER_HOME/catalog-backup-<catalog-id>.json` | CodexCommander が変更する前に作成した Codex モデルカタログのバックアップ。 |
| `$CODEX_HOME/config.toml` | ローカル専用構成では CodexCommander が管理するルート `openai_base_url` を追加します。ローカル以外のアドレスにバインドする場合は Codex が API 認証ヘッダーを送れるよう `model_provider = "codexcommander"` と `[model_providers.codexcommander]` を使います。 |
| `$CODEX_HOME/codexcommander.config.toml` | デフォルト Codex 設定と一緒に生成される参考用 fallback プロファイル。 |
| `$CODEX_HOME/codexcommander-catalog.json` | Codex が使うネイティブおよびルーティングモデルカタログ。 |

:::note
CodexCommander は Codex 設定を削除しません。`ccx stop`、`ccx restore`、`ccx eject` は
`config.toml` からマーカー所有の正確なルートだけを削除し、ネイティブ Codex を復元します。生成済みの
カタログやキャッシュは残ることがありますが、ネイティブ Codex は参照しません。タスク、履歴、認証には触れません。
:::

## 次へ

[クイックスタート](/ja/getting-started/quickstart/)に進んで最初のプロバイダーを設定するか、
アーキテクチャを知るには[仕組み](/ja/getting-started/how-it-works/)をお読みください。

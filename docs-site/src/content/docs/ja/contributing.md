---
title: コントリビュート
description: CodexCommander の開発環境、構成、規約、プロバイダーとアダプターの追加方法。
---

## セットアップ

```bash
cd /path/to/CodexCommander
bun install
bun run dev:proxy    # 開発モードのプロキシ API
bun run dev:gui      # ダッシュボード dev サーバー(別ターミナル)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` は引き続き `bun run dev:proxy` のエイリアスとして動作します。ダッシュボード dev サーバーは
`bun run dev:gui` で、`GET /` で提供するパッケージダッシュボードは `bun run build:gui` でビルドして
`gui/dist` に作成します。

## ビルドとテストコマンド

ルートパッケージは Bun ネイティブの TypeScript で、サーバーを別途 compile するステップはありません。リポジトリに
定義されたスクリプトを使えば、ローカル実行と CI を一致させられます。

```bash
bun run typecheck                 # 厳密な TypeScript 検査
bun run test                      # tests/ の全体スイート
bun test tests/router.test.ts     # 特定テストファイル
bun run build:gui                 # Vite GUI ビルド + パッケージ準備
bun run privacy:scan              # CI で使う資格情報/個人情報検査
bun run prepare:package           # パッケージランチャー/asset 更新
```

ほとんどのテストは `tests/*.test.ts` に並んで配置された Bun テストです。共有 fixture は
`tests/helpers/`、範囲の広いネイティブ等価性シナリオは `tests/e2e-style/` にあります。変更した
サブシステムの既存テストの近くに集中した回帰テストを追加してください。共有ルーティング、アダプター、設定、サーバー
動作を触った場合は全体スイートも実行します。

いま読んでいるドキュメントサイトは `docs-site/` にあります(Astro + Starlight)。

```bash
cd docs-site && bun install && bun dev
```

## ドキュメントサイト

ドキュメントは `docs-site/` にあり、現在公開中のホストはありません。ドキュメントの pull request を出す前に、ローカルでビルドしてください。

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

公開自動化はこのリポジトリに含まれていません。

## 継続的インテグレーション

すべての pull request と `main` へのすべての push では、自動チェックを **1 つ**だけ実行します:
**`ci`** (`.github/workflows/ci.yml`)。通常の貢献で必須の自動化はこれだけです。

リポジトリ管理者は、保護ルールが意図した管理者操作を阻む場合に GitHub ruleset の
**Always-allow** bypass を使えます。これは管理者の復旧と例外的な保守用であり、
コントリビューター作業のレビュー代替ではありません。

## ブランチと pull request

- **`main` が唯一の default / 統合 / PR ターゲットです。** 機能修正の PR は `main` に向けてください。
- 現在の **`main` tip** からブランチを切ってください。
- 説明文には、何をなぜ変えたかと、検証方法（実行したコマンドと結果）を書いてください。空や
  プレースホルダーだけの説明ではレビューできません。
- ダッシュボード UI を触る場合は、説明にスクリーンショットを含めてください。
- 振る舞い変更には、そのサブシステムの既存テスト近くに集中した回帰テストが必要です。共有
  ルーティング、アダプター、設定、サーバー変更ではフルスイートを通してください。

`main` 上の Bun ネイティブ TypeScript が唯一のランタイム線です。

リベース PR は歓迎します。古いブランチを現在の head に載せ直すのは通常の保守です。説明に
元コミットを書いてください。

## 規約

- **ES Modules のみ**(`import`/`export`)、TypeScript、`strict` モード。`bun x tsc --noEmit` をクリーンに
  保ってください。
- **ファイルあたり最大約 500 行** — 責任ごとに分割してください。単一の `index.ts` の後に小さく集中したモジュールを置いた
  `web-search/` と `vision/` サイドカーが良い例です。
- **非同期エラーは境界で処理** — サイドカーはリクエストパスにエラーを投げず、適切な marker で
  低下します。
- **Structure SOT** — 現在のメンテナンス不変条件は `structure/` に置きます。公開ユーザーワークフローは
  `docs-site/`、保守対象の技術・実装ノートは `docs/` に置きます。
- **export の保存** — 他のモジュールが依存している可能性があります。

## カタログにプロバイダーを追加

すべてのプロバイダー選択肢と seed は canonical レジストリ(`src/providers/registry.ts`)から派生します。

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` はこのエントリを `ccx init`、`ccx provider`、ダッシュボード preset、API キーログイン、
OAuth 設定 seed に供給します。`enrichProviderFromCatalog()` はモデルメタデータと capability 分類を
保存するプロバイダー設定にコピーします。OAuth プロトコル実装は引き続き `src/oauth/` にあります。
レジストリメタデータを追加するだけでは OAuth flow は生まれません。

## アダプターを追加

`src/adapters/` に `ProviderAdapter`([アダプター](/ja/reference/adapters/)参照)を実装し、
`src/server/adapter-resolve.ts` に名前を登録した後、出力を内部 `AdapterEvent` にブリッジしてください。画像
処理には `image.ts` を再利用し、一般的なストリーミング/ツール呼び出しは `openai-chat.ts` を参考にしてください。
アダプターが送信再試行を自ら担う場合のみ `fetchResponse` を使い、Cursor のような実際の双方向転送には
`runTurn` を使ってください。`tests/` の下に集中したテストを追加し、公開パッケージ API に含まれる
factory の場合は `src/index.ts` からも export してください。

## 完了を主張する前に検証

変更を証明する最も狭いコマンドから実行してください。型は `bun run typecheck`、動作は集中した
`bun test tests/<name>.test.ts` またはランタイム probe で確認した後、影響範囲に応じた広い gate を
実行します。CodexCommander は大きな batch より小さく検証可能な commit を好みます。

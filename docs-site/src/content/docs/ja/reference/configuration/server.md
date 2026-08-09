---
title: サーバーとランタイムの構成
description: リスナー、リモート アクセス、アドミッション キー、タイムアウト、ストレージ、サイドカー、シャドウ コール、および起動動作。
---

サーバー設定は、ローカル プロキシがリッスンする方法、リモート トラフィックを保護する方法、リソースを管理する方法、およびプロバイダー要求に関するヘルパー機能を実行する方法を制御します。

## サーバーフィールド

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` |プロキシリッスンポート。 |
| `hostname?` | `string` | `"127.0.0.1"` |バインドアドレス。非ループバック バインドには `CODEXCOMMANDER_API_AUTH_TOKEN` が必要です。 |
| `proxy?` | `string` | — |送信 HTTP(S) プロキシ URL または `${ENV_VAR}`。これらの変数が設定されていない場合にのみ、`HTTP_PROXY` / `HTTPS_PROXY` に適用されます。ループバックは `NO_PROXY` に残ります。 |
| `stallTimeoutSec?` | `number` | `300` | `response.incomplete` より前にアップストリーム データがない秒数。最小 1。
| `connectTimeoutMs?` | `number` | `200000` |試行ごとの DNS/TCP/TLS/最終ヘッダーの期限。本体が生成される前に終了します。 |
| `shutdownTimeoutMs?` | `number` | `5000` |アクティブなターンが中止される前の正常な排出期限。 |
| `websockets?` | `boolean` | `false` |応答 WebSocket パスとして `supports_websockets` をアドバタイズします。 False は HTTP/SSE を維持します。 |
| `corsAllowOrigins?` | `string[]` | `[]` | 追加の正確な CORS origin。ループバック origin は常に許可します。`chrome-extension://<extension-id>` など authority ベースのブラウザー拡張 origin に対応し、`*` はワイルドカードではありません。Firefox と Safari は拡張 UUID を（インストール/ブラウザー起動ごとに）再生成するため、origin が変わったらエントリを更新してください。 |
| `apiKeys?` | `CodexCommanderApiKey[]` | `[]` | 非ループバック バインドのデータプレーン認証で受け入れる、生成済みの `ccx_data_…` 資格情報。ダッシュボードで管理され、`/api/*` の認証には使用できません。 |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` |無効 |アーカイブされたセッションのクリーンアップ ポリシーをオプトインします。暗黙的に有効になることはありません。 |
| `appOwnedMemoryBudgetMb?` | `number` | `256` |排除可能なアプリ所有のログ、キャッシュ、BLOB、および継続ペイロードの MiB の上限。範囲は 64 ～ 4096。 RSSキャップではありません。 |
| `codexAutoStart?` | `boolean` | `true` | Codex を起動する前に、Codex シムで `ccx ensure` を実行させます。 False を指定すると、操作が行われないことが保証されます。 |
| `codexShimAutoRestore?` | `boolean` | `true` |完了した外部 Codex アップデートによってインストールされたシムが置き換えられた後、インストールされているシムを復元します。環境オプトアウト: `CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE=0`。 |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` |オフ |認識された Codex ヘルパー/シャドウ呼び出しを、少ない労力で選択したモデルにリダイレクトします。デフォルトのソースプレフィックスは `gpt-5.6-luna` です。`sourceModels` は現在のカスタムソースを明示的に指定するためのオーバーライドです。 |
| `webSearchSidecar?` | `CodexCommanderWebSearchSidecarConfig` |使用可能な場合はオン | Web 検索サイドカー オプション。 |
| `visionSidecar?` | `CodexCommanderVisionSidecarConfig` |使用可能な場合はオン |画像説明サイドカー オプション。 |
| `images?` | `CodexCommanderImagesConfig` | OpenAI の自動選択 | Codex `image_gen` のスタンドアロン イメージ リレー オプション。 |

## リモートアクセス

デフォルトの `127.0.0.1` バインドはループバックのみです。 `0.0.0.0` などの非ループバック アドレスには、`/api/*` とデータ プレーンの両方でトークン認証が必要です。開始する前にトークンをエクスポートします。

```bash
export CODEXCOMMANDER_API_AUTH_TOKEN="your-secret-token"
ccx start
```

プロキシは、この変数がないとリモート バインドを拒否します。バックグラウンド サービスの場合は、`ccx service install` の前にエクスポートして、launchd、systemd、またはタスク スケジューラがそれを受信できるようにします。クライアントは以下を送信する必要があります:

```text
x-codexcommander-api-key: your-secret-token
```

|エンドポイント | `Authorization: Bearer` | `x-codexcommander-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` |受け入れられません | **必須** |受け入れられません |
| `/v1/chat/completions` |受け入れられません | **必須** |受け入れられません |
| `/v1/messages` |受け入れられました |受け入れられました |受け入れられました |
| `/v1/models` |受け入れられました |受け入れられました |受け入れられました |

応答とチャット完了では、Codex Direct パススルーの可能性のために `Authorization` を予約しているため、そこでは専用のアドミッション ヘッダーのみが受け入れられます。ダッシュボードで生成された `apiKeys` は、起動後に環境トークンを置き換える可能性があります。候補は一定時間内に比較されます。

:::caution[LAN露出]
`0.0.0.0` バインドは、プロキシと構成されたプロバイダーの LAN へのアクセスを公開します。強力なトークンを持つ信頼できるネットワークでのみ使用してください。
:::

### SSHポートフォワーディング

リモート使用にはリモート バインドは必要ありません。ループバックを維持して転送します。

```bash
ssh -L 20100:localhost:10100 you@remote
```

任意のローカル ポートが機能します。ホストが `localhost`、`127.0.0.1`、または `::1` に解決されるリクエストは、ポートに関係なくループバックのままであるため、`http://localhost:20100/v1` が機能します。そのベース URL をクライアントに設定します。 `ccx` は、デフォルトのローカル `127.0.0.1` アドレスのみを管理対象クライアント設定に書き込みます。

プロバイダー OAuth コールバックは、固定リモート ポートでリッスンします。リモート マシンにログインするか、そのポートも転送します。

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

:::caution[転送されたループバックは認証されていません]
プレーン `ssh -L` はローカル ループバックでリッスンし、デフォルトの非認証バインドに対して安全です。 `ssh -g -L`、ブロードコンテナパブリッシング、または `0.0.0.0` でクライアント側を公開する転送モードを使用しないでください。不明な場合は、`ssh -L 127.0.0.1:20100:localhost:10100` と明示的にバインドします。
:::

## ストレージのクリーンアップ

`storageCleanupPolicy` はデフォルトでは無効になっています。有効にすると、アーカイブされたバイト数が `trigger.archivedBytesOver` を超えた後、`startup`、`daily`、`weekly`、または `manual` で実行されます。 `target.reduceToBytes` または `target.removeOldestPercent` のいずれかに向かって最も古いアーカイブが選択されます。 `mode` のデフォルトは `quarantine` です。 `permanent` は、明示的な破壊的な選択としてのみ使用してください。ポリシーは `lastRun` および `nextRun` を維持します。 [ストレージ] ページまたは `GET`/`PUT /api/storage/cleanup-policy` で設定します。 `POST /api/storage/cleanup-policy/run` を使用して手動実行をトリガーします。

## Claude Code (`claudeCode`)

これらの設定は、`/v1/messages`、`ccx claude` ランチャー、および Claude ダッシュボード ページを制御します。

|キー |タイプ |デフォルト |説明 |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` |合計時間ではなく、読み取り保留中のネイティブ パススルー ボディの非アクティブ バジェット (秒単位)。最小 1。正確には `0` が無効になります。 |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` |ストリーミングおよびバッファリングされた応答の累積的なネイティブ パススルー ボディ キャップ。まさに `0` が無効になります。 |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` |自動 |起動による `ANTHROPIC_AUTH_TOKEN` の処理方法。起動ごとに認証を自動検出します。明示的な値は決してオーバーライドされません。 |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` |継承 |生成された `~/.claude/agents/ccx-*.md` に書き込まれる作業量。 Codex のガイダンスおよびプロキシの上限とは別のものです。 `ccx claude` を通じて再起動して再生成します。 |

自動認証では、保存されているクロード認証が見つかった場合はサブスクリプションが選択され、見つからない場合はプロキシが選択され、検出が決定的でない場合は警告付きのサブスクリプションが選択されます。 [クロードコード認証モード](/guides/claude-code/#auth-mode)を参照してください。

## シャドウコール

Codex は、タイトルやコミット メッセージなどのタスクに小さなヘルパー モデルを使用します。 `shadowCallIntercept` を有効にして、認識されたソース モデル プレフィックスを別の構成済みモデルにリダイレクトします。交換作業は少ない労力で実行されます。`sourceModels` は現在のカスタムソースを明示的に指定する場合にのみ設定します。`x-codex-turn-metadata` で認識されたメンテナンス要求だけが対象となり、通常のターンと、メタデータがない、壊れている、または認識できない要求はインターセプトされません。

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

## サイドカー

### `images` (`CodexCommanderImagesConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `provider?` | `string` | OpenAI の自動選択 | `/v1/images/generations` および `/v1/images/edits` の明示的なカスタム API キー `openai-responses` プロバイダー。レジストリで管理されている ID は拒否されます。 |
| `timeoutMs?` | `number` | `300000` | 1 つのスタンドアロン イメージ リクエストのリクエスト全体のタイムアウト。 |

プロバイダーが見つからない、無効になっている、互換性がない、または使用可能なキーがない場合、明示的な選択は失敗して閉じられます。別の有料アップストリームにフォールバックすることはありません。エンドポイントは、Codex が期待する OpenAI Images API パスと応答形状を実装する必要があります。

### `webSearchSidecar` (`CodexCommanderWebSearchSidecarConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` |使用可能な場合はオン |マスタースイッチ。 |
| `backend?` | `"openai" \| "anthropic"` |自動 |明示的な勝利。それ以外の場合は使用可能な保存された Anthropic OAuth は `anthropic` を選択し、次に `openai` を選択します。 |
| `model?` | `string` |バックエンド依存 | OpenAI の場合は `gpt-5.6-luna`、Anthropic の場合は `claude-sonnet-5`。 |
| `reasoning?` | `string` | `low` |サイドカーの取り組み。 `minimal` は Web 検索で拒否されます。 |
| `maxSearchesPerTurn?` | `number` | `3` |メインモデルのターンごとに許可される実際の検索。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` |設定ファイルのみのルーテッド モデルの raw ボディの非アクティブ期限。整数 1 ～ 2147483647。空でないすべてのチャンクがリセットされます。 |
| `timeoutMs?` | `number` | `60000` | 1 つのホストされた検索の期限。 |

OpenAI バックエンドには、ChatGPT ログインと有効な ChatGPT `forward` プロバイダーが必要です。クロードインバウンドのルーティングされたリプレイは、メインの ChatGPT 認証を内部リクエストに挿入します。 Anthropic バックエンドは、有効な Anthropic OAuth プロバイダーからのアクティブに保存された資格情報を使用します。使用可能なアカウントがない、明示的に選択された Anthropic バックエンドは、フォールバックせずに失敗して閉じられます。 Anthropic executor は、ネイティブの `web_search_20250305` ツールを使用します。

検索は 4 つのクロック (ベース `stallTimeoutSec`、`connectTimeoutMs`、ルーテッド モデルの非アクティビティ、ホスト型検索のタイムアウト) によって制御されます。有効なブリッジ ウォッチドッグは、最大プラス 30 秒です。ルート ストールは非アクティブ ガードであり、総生成期限ではありません。

### `visionSidecar` (`CodexCommanderVisionSidecarConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` |使用可能な場合はオン |マスターイメージと説明のスイッチ。 |
| `backend?` | `"openai" \| "anthropic"` |自動 | Web 検索と同じ、明示的優先、人間認証情報を意識した選択。 |
| `model?` | `string` |バックエンド依存 | OpenAI の場合は `gpt-5.4-mini`、Anthropic の場合は `claude-sonnet-5`。 |
| `maxDescriptionsPerTurn?` | `number` | `8` |新しい説明のキャッシュミスはメインターンごとに許可されます。 `0` は通話を無効にします。無効な値にはデフォルトが使用されます。 |
| `timeoutMs?` | `number` | `45000` |サイドカーのフェッチタイムアウト。 |

Vision は、プロバイダーの `noVisionModels` のモデルに送信された画像に対してのみアクティブになります。 OpenAI には、検索と同じログイン/転送要件があります。明示的に選択された Anthropic は、使用可能な認証情報がないと失敗します。成功した `data:` 記述では、バックエンド、モデル、詳細、画像バイト、および正規化されたメッセージ コンテキストをキーとした境界付きキャッシュが使用されます。ヒットと同じターンの重複は制限を消費しません。リモート `https:` イメージと失敗した説明、または空の説明はキャッシュされません。

Anthropic OAuth サイドカーは、CodexCommander の既存のクロード コード OAuth フィンガープリントを再利用します。対象のアカウントとワークロードをソークテストします。

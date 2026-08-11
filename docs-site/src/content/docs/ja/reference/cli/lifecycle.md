---
title: CLI ライフサイクル
description: セットアップ、開始、停止、サービス、診断、および同期コマンド。
---

これらのコマンドは、ローカル CodexCommander プロキシとその Codex 統合をインストール、実行、検査、および修復します。

## 設定

### `ccx init`・`ccx setup`

対話型セットアップ ウィザード (`setup` は `init` のエイリアスです)。プロバイダー (プリセットまたはカスタム)、API キー (リテラルまたは `${ENV}`)、デフォルトのモデル、およびプロキシ ポートの入力を求めるプロンプトが表示されます。 `~/.codexcommander/config.json` を保存します。オプションでプロキシを `$CODEX_HOME/config.toml` (デフォルトは `~/.codex/config.toml`) に挿入します。オプションで Codex 自動起動シムをインストールします。

## プロキシのライフサイクル

### `ccx start [--port <port>]`

プロキシ サーバー (優先ポート `10100`) を起動します。そのポートが占有されている場合、CodexCommander は別の使用可能なポートを選択して記録します。 PID/ランタイムポートの状態を書き込み、2 番目のライブインスタンスの起動を拒否します。開始時に、各プロバイダーのモデルを Codex のカタログに同期します。マネージド サービス (`CCX_SERVICE=1`) として起動されていない限り、シャットダウン時にネイティブ Codex が復元されます。

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

実行中のプロキシを (PID によって) 停止し、PID ファイルを削除して、ネイティブ Codex を復元します。マネージド バックグラウンド サービスがインストールされている場合、`ccx stop` はそれを最初に停止するため、プロキシを再起動できません。同じアクションは、Web ダッシュボードの **停止** ボタン (`POST /api/stop`) から実行できます。

### `ccx restart`

`stop` に続いて `ensure` を実行します。プロキシ/サービスを停止し、ネイティブ Codex を復元し、バックグラウンドでプロキシを起動し、ライブ ポートを Codex に同期します。

### `ccx ensure`

バックグラウンド プロキシが実行されていることを冪等的に確認してから、そのライブ モデル カタログを同期します。 `codexAutoStart` が `false` の場合、自動起動が無効であることが出力され、何も行われません。

### `ccx restore [back]`・`ccx eject [back]`

プロキシを停止せずに**ネイティブ Codex を復元します。挿入された設定行とルーティングされたカタログ エントリを削除し、プレーンな `codex` が再びネイティブに動作するようにします。 `eject` は `restore` の別名です。

プロキシのライフサイクルを変更せずに、既に実行されているプロキシでプレーン `codex` を再指定するには、`back` をどちらかのスペルに渡します。

```bash
ccx restore back
ccx eject back
```

### `ccx uninstall`・`ccx remove`

すべての復元手順が成功した場合にのみ、サービスとプロキシを停止し、サービスと Codex シムを削除し、ネイティブ Codex を復元してから、CodexCommander ローカル設定を削除します。 `remove` は `uninstall` の別名です。設定のクリーンアップには正規の所有権メタデータが必要です。所有されていないディレクトリまたは共有ディレクトリはそのまま残ります。

## ステータスと健康状態

### `ccx status [--json]`

読み取り専用の診断概要を出力します: プロキシ PID、`/healthz` 到達可能性、ダッシュボード URL、構成パス、デフォルト プロバイダー、Codex 自動起動設定、サービス状態、シム状態、および編集された有効な Codex ホーム。明示的で信頼性の高い Windows Orca ランタイム ホーム署名のみが、実用的なアプリとホームの不一致の警告を追加します。 `CODEX_HOME` が自動的に変更されることはありません。

人間の出力には、OAuth ログイン概要の後の **OAuth health** ブロックも含まれます。つまり、既知のすべてのアカウントが正常な場合は `OAuth health: ok`、または正常でないアカウントごとに 1 行が編集された `OAuth health: warning` (プロバイダー、マスクされたアカウント ID、再認証が必要、レートまたはクォータの制限、または更新の競合などのステータス) と、オプションの `Action:` ヒントが含まれます。アカウント ID は編集されます。トークンと電子メールは決して印刷されません。 `--json` 契約には現在、このヘルス ブロックは含まれていません。

```bash
ccx status
ccx status --json
```

省略形の例:

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

実際のオブジェクトには、`listen` (ポート、ホスト名、ランタイム/構成ソース)、構成ロード診断、およびバンドルされた Codex プラグイン診断も含まれています。 JSON スキーマは加算専用です。将来のバージョンではフィールドが追加される可能性がありますが、既存のフィールドは安定したままになるはずです。 API キー、OAuth トークン、認証ヘッダー、リクエスト コンテンツ、電子メール、アカウント ID は意図的に除外されます。

### `ccx health [--json]`

稼働中のプロキシの ID を確認します。ヒューマン出力は PID/ポートをレポートします。 `--json` は `{ok, pid, port}` を出力します。このコマンドは正常な場合のみ 0 で終了し、それ以外の場合は 1 で終了するため、サービス プローブに適しています。

### `ccx ready [--json] [--wait [--timeout <seconds>]]`

認証不要の `GET /readyz` エンドポイントで同期後の準備状態を確認します。準備完了時は `200`、
`pending` または終端状態の `failed` では `Retry-After: 1` とともに `503` を返します。HTTP の
サニタイズ済み識別フィールドは `{service, version, uptime, pid, port, status}` です。`/healthz` は
readiness ではなく別の liveness 確認です。
デフォルトでは 1 回だけ probe します。`--wait` は準備完了または timeout まで polling しますが、
終端 `failed` を確認すると即座に終了します。デフォルト timeout は 45 秒で、`--timeout <seconds>` には
`--wait` が必要です（1〜300 秒の正の整数）。CLI JSON は
`{ready, status, pid, port}` を出力し、`status` は `ready`、`pending`、`failed`、`unreachable` の
いずれかです。終了コードは ready が 0、not-ready/pending/failed/timeout/unreachable が 1、
不正な引数が 64 です。

### `ccx doctor`

読み取り専用環境と接続の診断を実行します: 状態パスとファイル システム タイプ、WSL デュアル インストール、プロキシ環境/構成、ChatGPT の到達可能性、Codex プラグインとプロジェクト設定の警告。Codex のアプリとホームのターゲット設定セクションでは、Windows Orca ランタイムとホームの狭い不一致も検出し、該当する場合は手動のアンインストール、環境設定、再インストール手順を表示します。この診断によって表示されるパスでは、OS ユーザー名が編集されます。Doctor は修復ヒントを出力しますが、適用しません。

**OAuth の信頼性** セクションでは、資格情報ストレージが書き込み可能かどうか、リフレッシュ シングルフライト/ロック ファイルが `CODEXCOMMANDER_HOME` で作成できるかどうか、回復 `Action:` を持つ正常でない OAuth または Codex プール アカウント (編集された ID)、および Codex 転送パスが公式クライアント メタデータを作成しない静的 OK が報告されます。 Doctor は資格情報を変更したり、修復を適用したりすることはありません。

:::note[アップグレード時の 1 回限りの再起動]
古いビルドから実行中のプロキシでは、保護されたランタイムレコードに `attestationSecret` がない場合があります。CLI 管理コマンドや資格情報を渡す Claude/OpenCode クライアントを起動する前に、そのプロキシを 1 回再起動してください。それまでは機密リクエストは fail closed となり、公開 health 情報や設定ポートだけで見つかった listener に token や request body を送る fallback は行いません。
:::

## カタログの同期

### `ccx sync [--restart-codex]`

構成されているすべてのプロバイダーからライブ モデル リストを取得し、マージされたカタログを Codex に再挿入します。プロバイダーを追加した後、または利用可能なモデルを更新するために実行します。

存続期間の長い Codex `app-server` プロセスがまだ実行されている場合、`ccx sync` は、`codexcommander-catalog.json` / `models_cache.json` が更新されても、以前のメモリ内モデル リストを提供し続ける可能性があることを警告します。現在のユーザーが所有する一致する `codex … app-server` および `codex-code-mode-host` プロセスにのみ `SIGTERM` を送信するには、`--restart-codex` を渡します (アクティブなターンが中断される可能性があります)。広範な `pkill -f codex` 一致は意図的に回避されます。

通常の `ccx sync` は非中断です。同じ app-server 内で新しいタスクを開始または fork してもカタログは再読み込みされません。ダッシュボードの **Apply agent catalog**、`ccx sync --restart-codex`、または Codex Desktop の終了・再起動を使用します。

### `ccx sync-cache [--restart-codex]`

Codex のローカル モデル ピッカー キャッシュを無効にし、アクティブな CodexCommander カタログから再構築されるようにします。 `ccx sync` と同じ、古い `app-server` 警告とオプションの `--restart-codex` 動作が適用されます。

## バックグラウンドサービス

### `ccx service [install|repair|start|stop|status|uninstall|remove]`

CodexCommander を、ログイン時に自動起動し、クラッシュ時に自動再起動するログイン管理バックグラウンド サービス (macOS **launchd**、Linux **systemd ユーザー ユニット**、Windows **タスク スケジューラ**) として実行します。サービスは `CCX_SERVICE=1` を設定して実行されるため、再起動によって Codex 設定が変更されることはありません。

|サブコマンド |アクション |
| --- | --- |
|なし |サービスを作成/更新して開始します。 |
| `install` |サービスを作成して開始します。 |
| `repair` | 既存のサービスを再登録せずに更新して再起動します。 |
| `start` |インストールされているサービスを開始します。 |
| `stop` |サービスを停止し、ネイティブ Codex を復元します。 |
| `status` |サービスとプロキシの診断とログ パスをレポートします。 |
| `uninstall` |サービスを削除し、ネイティブ Codex を復元します。 |
| `remove` | `uninstall`の別名。 |

```bash
ccx service
ccx service install
ccx service repair
ccx service status
ccx service uninstall
```

Windows では、`ccx service status` は、ID 検証済みの CodexCommander プロキシの到達可能性とは別に、タスク スケジューラの登録を報告します。ローカライズされた `schtasks` テーブルは出力されないため、概要は Windows コード ページ間で読み取れるままです。

Windows では、タスク スケジューラ エントリを作成するには昇格が必要です。認識されたローカライズされたアクセス拒否テキストは、既存のガイダンス パスを維持します。そのテキストが判読できない場合、フォールバックには、所有されているコマンド形状 `/create /tn codexcommander-proxy /xml <non-empty-path> /f`、ステータス 1、および確認済みの非昇格トークンが必要です。ダッシュボードのスタートアップ セーフティ アクションは、UAC を自動的に要求できるようになります。そのフォールバックがトークンの状態を判断できない場合、元のスケジューラ エラーが保持されます。外部タスクおよび操作は、自動昇格マーカーを発行することはできません。ダッシュボードの UAC プロンプトを承認するか、管理者特権の PowerShell ウィンドウで `ccx service install` を再実行します。

### `ccx codex-shim <install|status|uninstall|remove>`

軽量の自動起動スクリプトを使用して、スクリプトベースの `codex` ランチャーを PATH 上にラップします。実際の `codex.exe` ターゲットは、正確な実行可能呼び出しの破損を避けるため、変更されないまま残されます。

完了した外部 Codex アップデートがインストールされている shim を上書きした場合、次の通常の `ccx` コマンドは安定した新しいランチャーをバックアップし、ディスパッチ前に shim を復元します。まだ変更中のランチャーは変更されず、後で再試行されます。修復の失敗は、要求されたコマンドを失敗させることなく警告します。手動フォールバック: `ccx codex-shim install`。 `codexShimAutoRestore` を `false` に設定するか、プロセス レベルのオプトアウトの場合は `CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE=0` を設定します。

|サブコマンド |アクション |
| --- | --- |
| `install` |シムを取り付けます（または古い場合は修理します）。 |
| `uninstall` |シムを削除し、元の Codex バイナリを復元します。 |
| `remove` | `uninstall`の別名。 |
| `status` |シムの状態 (インストール済み、古い、または欠落) を報告します。 |

```bash
ccx codex-shim install
ccx codex-shim status
ccx codex-shim uninstall
```

:::tip[サービス vs シム]
常時オンのバックグラウンド プロキシには `ccx service` を使用します (推奨)。デーモンを使用しない軽量のオンデマンド起動には、`ccx codex-shim` を使用します。プロキシは、`codex` が起動された場合にのみ起動します。
:::

### `ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Windows ステータス トレイ アイコンをインストールして制御します。 Windows ログイン時に開始され、ワンクリックでプロキシ コントロールを提供します。 `start` および `stop` はアイコンのみを制御します。そのメニューを使用してプロキシを制御します。 `--no-start` は `install` に適用され、トレイをすぐに起動せずにインストールします。

## ダッシュボード

### `ccx gui`

`http://localhost:<port>` で [ウェブダッシュボード](/guides/web-dashboard/) を開き、必要ならプロキシを自動起動します。短時間・1 回限りのブラウザー起動チケットにより、確認済みの **Apply agent catalog** を含む変更操作が利用できます。チケットは URL フラグメントだけで渡され、交換中に削除されます。永続的な管理トークンが URL や Web Storage に入ることはありません。確認済みセッションはプロセスメモリ内だけに最大 8 時間存在し、更新されません。期限切れまたはプロキシ再起動後の次の API リクエストは `401` になります。`ccx gui` または macOS メニューアプリから開き直してください。ループバックページを手動で開いても API セッションは発行されず、永続的な管理トークンを要求も送信もしません。

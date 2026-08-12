---
title: CLI ライフサイクル
description: セットアップ、開始、停止、サービス、診断、および同期コマンド。
---

これらのコマンドは、ローカル CodexCommander プロキシとその Codex 統合をインストール、実行、検査、および修復します。

## 設定

### `ccx init`・`ccx setup`

対話型セットアップ ウィザード (`setup` は `init` のエイリアスです)。プロバイダー (プリセットまたはカスタム)、API キー (リテラルまたは `${ENV}`)、デフォルトのモデル、およびプロキシ ポートの入力を求め、`~/.codexcommander/config.json` に保存します。必要に応じて、保護された current-home runtime record で確認済みの実行中プロキシ経由に Codex を切り替え、Codex 自動起動 shim をインストールします。確認済みのプロキシがなければ Codex はネイティブのままで、後の `ccx start` が明示的な起動とルーティングを行います。`init` 自体がプロキシを起動したり、未確認の listener への route を書いたりすることはありません。

## プロキシのライフサイクル

### `ccx start [--port <port>]`

プロキシ サーバー (優先ポート `10100`) を起動します。そのポートが占有されている場合、CodexCommander は別の使用可能なポートを選択して記録します。PID/ランタイムポートの状態を書き込み、2 番目のライブインスタンスの起動を拒否します。明示的な起動では Codex 統合を有効にし、各プロバイダーのモデルを Codex のカタログに同期して、Codex を稼働中のプロキシ経由にルーティングします。これには `ccx start`、トレイの Start、および明示的な `ccx service start`、`install`、`repair` が含まれます。`ccx ensure` は意図的に無効化された統合状態を維持します。マネージド サービス (`CCX_SERVICE=1`) として起動されていない限り、通常のスタンドアロン終了時にネイティブ Codex が復元されます。

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

まずネイティブ Codex ルーティングを復元し、その後で実行中のプロキシを (PID によって) 停止して PID ファイルを削除します。ネイティブルートを検証できない場合、プロキシとサービスは実行を続けます。マネージド バックグラウンド サービスがインストールされている場合、`ccx stop` はネイティブへの復元後にサービスを停止し、プロキシが再生成されないようにします。Web ダッシュボードの **停止** ボタンは raw `POST /api/stop` を呼び出します。supervisor のないプロキシは停止できますが、インストール済み supervisor が所有している場合は拒否されます。その場合は、同じライフサイクル権限の下で manager を先に停止できる CLI またはトレイの Stop を使用してください。

### `ccx restart`

macOS トレイの **Restart Proxy…** と同じ安全な stop→start 処理を実行します。古いプロキシ/サービスを終了する前にネイティブ Codex を復元して検証し、その後、明示的な Start フェーズで新しいプロキシを起動して Codex を再びそこへルーティングします。再起動に失敗した場合、Codex はネイティブのままです。

### `ccx ensure`

バックグラウンド プロキシが実行されていることを冪等的に確認してから、そのライブ モデル カタログを同期します。 `codexAutoStart` が `false` の場合、自動起動が無効であることが出力され、何も行われません。

### `ccx restore [back]`・`ccx eject [back]`

プロキシを停止せずに**ネイティブ Codex を復元**します。ネイティブへの切り替えでは、<code>$CODEX_HOME/config.toml</code> から CodexCommander のマーカーが所有する正確なルートと、その所有対象のカタログポインターだけを削除し、関係のない設定はすべて保持します。カタログ、タスク、履歴、認証を読み取ったり書き換えたりしません。修復コマンドもコーディネーターデータベースも必要ありません。`eject` は `restore` の別名です。生成済みのカタログやキャッシュはディスクに残ることがありますが、ネイティブ Codex からは参照されません。このコマンドは Codex 専用で、Grok やその他のクライアント統合は変更しません。管理対象のすべてのネイティブクライアントルートを停止する場合は、`ccx stop` または `ccx uninstall` を使用してください。

プロキシのライフサイクルを変更せずに、既に実行されているプロキシへプレーン `codex` を再指定するには、`back` をどちらかのスペルに渡します。Route Back は明示的な ON 遷移です。recovery journal は別のルート設定ではなく、CodexCommander が書いた正確な config/profile の保護された復旧チェックポイントです。目的の統合がすでに ON で、検証済みの current-home 稼働中プロキシが安定した journal を所有し、記録された profile postimage が現在の profile と正確に一致する場合、Route Back は、記録された config postimage との完全一致、または管理対象ルートを除去すると独立して native-safe になる安定した正確な marker-owned managed descendant のいずれかを受け入れます。これにより sync 後の無関係な Codex 設定変更が許可されます。Route Back は active journal を保持して冪等な no-op として成功します。native/OFF からは、既存の coordination が stale と証明した journal だけを退役させます。所有者または profile の不一致、証明の欠落、改ざんされた/custom/曖昧なルーティング、一時書き込み surface、または観測中の競合がある場合、Codex は native/OFF のままです。journal を手動で削除または編集しないでください。

```bash
ccx restore back
ccx eject back
```

Restore Native または Route Back が成功したら、ChatGPT を完全に終了し、開き直してから新しいタスクを
開始し、実行中の Codex ホストに保存済みルートを読み込ませてください。

### `ccx uninstall`・`ccx remove`

1 つのライフサイクルトランザクションとしてサービスとプロキシを停止し、サービスと Codex シムを削除し、ネイティブ Codex を復元して再検証します。すべての手順が成功した場合にのみ、CodexCommander のローカル成果物を削除します。`remove` は `uninstall` の別名です。設定のクリーンアップには正規の所有権メタデータが必要で、所有されていないディレクトリまたは共有ディレクトリはそのまま残ります。同時実行の Start が 2 つ目のライフサイクルロック名前空間を作成できないよう、小さな owner/manifest メタデータのペアは設定ルートに保持されます。

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

CodexCommander を、ログイン時に自動起動し、クラッシュ時に自動再起動するログイン管理バックグラウンド サービス (macOS **launchd**、Linux **systemd ユーザー ユニット**、Windows **タスク スケジューラ**) として実行します。サービスは `CCX_SERVICE=1` を設定して実行されるため、マネージャーによる自動再起動で Codex 設定を書き換えません。明示的なサービスの作成、`install`、`repair`、`start` は Codex 統合を有効にし、Codex をプロキシ経由にルーティングします。

|サブコマンド |アクション |
| --- | --- |
|なし |サービスを作成/更新して開始します。 |
| `install` |サービスを作成して開始します。 |
| `repair` | 既存のサービスを再登録せずに更新して再起動します。 |
| `start` |インストールされているサービスを開始します。 |
| `stop` |ネイティブ Codex を復元して検証してからサービスを停止します。復元を検証できない場合、サービスとプロキシは実行を続けます。 |
| `status` |サービスとプロキシの診断とログ パスをレポートします。 |
| `uninstall` |ネイティブ Codex を復元して検証してからサービスを削除します。 |
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

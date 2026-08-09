---
title: Windows メモリの増加
description: Windows 上で bun プロセスが何ギガバイトもの RAM に増加する可能性がある理由、CodexCommander が現在それに対して行っていること、およびアップストリームの Bun 修正がリリースされるまでのオプション。
---

一部の Windows ユーザーは、CodexCommander の背後にある `bun` プロセスが、長時間のストリーミング セッション中に数ギガバイトの RSS に増加するのを目にします (問題 [#314](https://github.com/pavelhov/CodexCommander/issues/314) として報告されています)。このページでは、実際に何が起こっているのか、そしてそれに対して何ができるのかを率直に説明します。

## 根本原因: アップストリームの Bun ランタイムの問題

CodexCommander には Bun ランタイム (現在 **1.3.14**) がバンドルされています。メモリの増加は、プロキシでの JavaScript レベルのリークではなく、アップストリームの既知の Bun の問題によって引き起こされます。

|パン問題 |状態 (2026-07-23 確認) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` 受信バックプレッシャーは JS 消費に関係しません。 [PR #29831](https://github.com/oven-sh/bun/pull/29831) によって修正されました。 **どのリリースがそれを搭載しているかは未検証です** — バンドルされている 1.3.14 には搭載されていないと想定しています。
| [#32111](https://github.com/oven-sh/bun/issues/32111) — クライアントが非同期プル ストリームを中止するとクラッシュします。 2026 年 6 月 21 日にマージされた [PR #32120](https://github.com/oven-sh/bun/pull/32120) を修正。 1.3.14 には存在しないと想定されています。注: このクラッシュは **Windows 固有のものではありません** (macOS/Linux でも再現されました)。
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` ソケット ハンドルのリーク |上流はまだ **営業中** |

Windows では、#32111 クラッシュを回避するために、CodexCommander は保守的なコード パスで応答をストリーミングし続ける必要があります。そのパスはバックプレッシャーの問題に最もさらされるパスです。低速または停止したクライアントは、JavaScript がバインドできないネイティブ メモリにアップストリーム データをバッファリングしているランタイムを残す可能性があります。

## CodexCommander の現在の対応

制限付きの緩和と可視性 — **修正ではありません**。バンドルされた 1.3.14 ランタイムでは、リーク自体は上流の問題のままです。

- **メモリ ウォッチドッグ** - プロキシは、毎分自身のメモリをサンプリングし、ログに記録します。
観測されたメモリが 4 GiB を超えると、レート制限の警告が表示されます。 Windows ワーキング セット/RSS カウンターがコミットされた外部保持を過小報告する可能性があるため、観測されたメモリは RSS、`external`、および `arrayBuffers` の最大値になります (これらの合計ではありません)。
- **`ccx doctor`** — 「メモリ / ランタイム」セクションには *サービス* が表示されます
プロセスの Bun バージョン、RSS、外部/ArrayBuffers カウンター、JS ヒープ コンテキスト、およびストリーム モードの決定。バンドルされている Bun 1.3.14 ランタイムでは、`heapUsed` / `jscHeap` 単独ではリーク識別子ではありません。アプリレベルのリークを割り当てる前に、観察されたメモリを `responseState` および繰り返しサンプルと比較します。
- **`GET /api/system/memory`** — 認証済みの同じデータ
ダッシュボードまたはスクリプトの管理 API。 RSS/ヒープ/外部カウンターとともに、プロキシのメモリ内 `previous_response_id` 継続ストアのスカラー `responseState` ブロック (エントリ数、シリアル化された合計/最大バイト数、最も古いエントリの経過時間) を報告します。これはさらに成長に起因します。観察された記憶の上昇下での `responseState.totalBytes` の上昇は会話の保持を指します (長い `store:false` チェーンはターンごとに再拡張します)。一方、観察された記憶の上昇の下での横ばいの `responseState` はそのストアから遠ざかることを示します。値はスカラーのみであり、リクエスト本文、トークン、パス、アカウント識別子はありません。また、読み取りには副作用はありません (プルーニングや削除は行われません)。ダッシュボードの **メモリ可観測性** カードは同じフィールドをレンダリングし、確認ゲート付き **ドレインと再起動** アクションを提供します。現在のアクティブ ターン数を表示し、アクティブ ターンを最大 60 秒待機し (既存の 503 + `Retry-After` ドレインを再利用)、残りのターンを中止し、ライブ ポート (または障害専用サービス スーパーバイザ) 上の `ccx start` 経由でプロキシを再起動します。 respawn）Codex インジェクションを破棄せずに。これは、`POST /api/stop` の短いドレインよりも長く、情報に基づいたリサイクルです。
- **ゲートされた代替ストリーム パス** — tee と JavaScript rewrite の連鎖を取り除く、有界の single-reader relay です。Windows の rewrite トラフィックでは既に使用され、通常の Windows トラフィックは引き続きランタイム ゲートに従います。macOS では、opt-in の plaintext V2 collaboration が実際に client rewrite を有効化し、検証済みの bundled Bun 1.3.14 を使用している場合に限り、`auto` が同期 `pull()` の正確な relay を選びます。これは [#1127](https://github.com/pavelhov/CodexCommander/issues/1127) の terminal delivery hang を直す限定的な経路であり、Bun 1.3.14 に汎用の #32111 修正が含まれるとは主張しません。他の macOS rewrite は明示的 opt-in のままです。memory endpoint は in-flight、cancel、abort、error、queue watermark のスカラー counter だけを公開し、body や request identity は含みません。

これらの変更による実際の RSS の改善は **Windows ユーザーによる検証を待っています**。リークが修正されたとは主張しません。

しきい値ベースの自動再起動は意図的に**出荷されていません**。プロセスがクラッシュした場合、サービス マネージャー (タスク スケジューラ/WinSW、launchd、systemd) がすでにプロセスを再起動しています。

## 選択肢

1. **バンドルされたランタイム更新を待ちます。** Bun が検証可能にリリースされたら
修正が適用され、CodexCommander はバンドルされたランタイムを更新し、Windows の no-rewrite stream path が自動的にオンになります。上記の macOS plaintext-V2 `auto` 例外は、これとは独立して特定の Bun バージョンに固定されています。

2. **`CCX_BUN_PATH` を使用して信頼できる Bun ランタイムを実行します。** これは
未検証の領域 — 私たちがテストしていないランタイムで CodexCommander を実行しています。自己責任で。サービスのインストールにとって重要: オーバーライドは、サービスの開始時ではなく、**サービス アーティファクトの生成時に**読み込まれます。環境変数を設定し、同じシェルから `ccx service repair` を再実行すると、パスが永続サービス定義に組み込まれます。 env を設定するだけでは、すでにインストールされているサービスには何も影響しません。

3. **`streamMode: "eager-relay"` を使用して有界リレーにオプトインします。** 2 つの方法:
`config.json` を編集する (`"streamMode": "eager-relay"` を追加する) か、管理 API を呼び出します。`PUT /api/settings` と `{"streamMode":"eager-relay"}` は、再起動せずに新しいターンに適用されます。 **クラッシュのリスク警告:** Bun 1.3.14 の汎用 async-pull stream は引き続き #32111 の影響を受けるため、未検証の形状に eager relay を強制すると、どの OS でもプロセスがクラッシュする可能性があります。サービス マネージャーは再起動しますが、実行中のリクエストは失敗します。`"safe-tee"` は tee を固定し、macOS plaintext-V2 の auto 例外も無効にします。Windows の `"auto"` (デフォルト) はランタイム ゲートに従います。macOS の `"auto"` は、検証済みの plaintext-V2 collaboration rewrite だけを例外として tee を維持し、明示的な `"eager-relay"` は他の適格な SSE ターンを opt-in します。

これらのいずれかを実際の Windows ワークロードで試した場合は、[#314](https://github.com/pavelhov/CodexCommander/issues/314) の `ccx doctor` メモリ セクションの前後を報告してください。これがまさにこの軽減策が待っている検証です。

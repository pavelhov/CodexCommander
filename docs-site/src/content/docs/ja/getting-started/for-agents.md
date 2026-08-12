---
title: エージェントのクイックスタート
description: ユーザー同意の境界を越えずに、エージェント主導またはスクリプト化された端末から CodexCommander をインストールして操作します。
---

このページは、端末から作業する AI エージェントやスクリプト利用者向けです。コマンド、終了ステータス、安全なヘッドレス運用に焦点を当てています。人間が操作しながら進める場合は、[クイックスタート](/getting-started/quickstart/) を参照してください。対話形式で設定する場合は、[Web ダッシュボード](/guides/web-dashboard/)も利用できます。

## CodexCommander のセットアップ

既存のソースチェックアウトを使用します。レジストリパッケージは現在公開されていません。

```bash
bun install
bun run build:gui
bun run src/cli/index.ts --version
```

プロキシを実行する方法を 1 つ選択します。

```bash
# Foreground: blocks this terminal until stopped.
bun run src/cli/index.ts start

# Background: installs or updates the service, then starts it.
bun run src/cli/index.ts service
```

対話型端末で `ccx init` を実行します。 `ccx start` がフォアグラウンドを占有している場合は、2 番目の端末を使用します。

```bash
bun run src/cli/index.ts init
```

以降の `ccx <args>` は、このチェックアウトでは `bun run src/cli/index.ts <args>` として実行できます。

ウィザードは `$CODEXCOMMANDER_HOME/config.json` (通常は `~/.codexcommander/config.json`) を書き込みます。保護された current-home runtime record で確認済みの実行中プロキシがある場合だけ Codex をそこへ向け、任意で Codex の自動起動 shim をインストールできます。`ccx init` 自体はプロキシを起動せず、未確認の listener への route も書きません。確認済みプロキシがなければ、`ccx start` まで Codex はネイティブのままです。完全に非対話型でセットアップする場合は、ウィザードを操作せず、以下のように `ccx provider add` でプロバイダーを設定します。

## ヘッドレスインストールを確認する

スクリプトおよびエージェントの実行では、次の読み取り専用チェックを使用します。

```bash
ccx status
ccx doctor
ccx health --json
```

`ccx status` はプロキシとサービスの状態を報告します。`ccx doctor` は、ローカル環境、ネットワーク、Codex ランタイム、アカウントの健全性に関する問題を診断します。`ccx health` はプロキシが正常なら終了コード `0`、それ以外なら `1` を返します。`--json` を付けると構造化された出力を返します。

`ccx combo set` など、管理 API を利用するコマンドは稼働中のプロキシに接続します。プロキシが見つからない場合や API に到達できない場合、CLI は `503` エラーとして扱い、非ゼロで終了します。再試行する前に、フォアグラウンドのプロキシまたはバックグラウンドサービスを起動してください。コマンドとエンドポイントの全体像は、[CLI リファレンス](/reference/cli/) と [管理 API](/reference/management-api/) を参照してください。

## ダッシュボードを使用せずにプロバイダーとコンボを追加する

レジストリ プロバイダーは名前で追加できます。たとえば、これは Anthropic API キー プリセットを追加し、それをデフォルトのプロバイダーにします。

```bash
ccx provider add anthropic-apikey \
  --api-key "$ANTHROPIC_API_KEY" \
  --set-default
```

`ccx provider add` はローカル設定を書き込みます。稼働中のプロキシがすでに実行中で、モデルを Codex にすぐに同期したい場合は、`--sync` を追加します。それ以外の場合は、後で `ccx sync` を実行します。レジストリにないカスタム プロバイダーには、`--adapter` と `--base-url` の両方が必要です。

すべてのターゲット プロバイダーが構成され、プロキシが実行されたら、フェイルオーバー コンボを作成します。

```bash
ccx combo set main \
  --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol \
  --strategy failover
```

ターゲットは `provider/model` 構文を使用し、カンマで区切られます。結果として得られる仮想モデルは `combo/main` です。戦略、重み、スティッキー ルーティング、および障害動作については、[コンボ](/guides/combos/) を参照してください。

## リモートとLANのバインド

デフォルトのループバック バインドには API トークンは必要ありません。 `0.0.0.0` などの非ループバック バインドには `CODEXCOMMANDER_API_AUTH_TOKEN` が必要です。プロキシはそれなしでは起動を拒否します。変数を `ccx start` の前、または `ccx service install` の前に設定して、サービスがそれを受け取るようにします。

```bash
export CODEXCOMMANDER_API_AUTH_TOKEN="your-secret-token"
ccx service install
```

その後、クライアントは管理リクエストとモデルリクエストを認証する必要があります。 CodexCommander をローカル マシンの外に公開する前に、[構成](/reference/configuration/) のリモート アクセス ルールを読んでください。

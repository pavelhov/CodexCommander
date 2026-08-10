---
title: グロクビルド
description: xAI の Grok Build CLI から CodexCommander でルーティングされたモデルを使用します。モデルはプロキシの実行中に ~/.grok/config.toml に自動登録されます。
---

CodexCommander はローカル ポート上で OpenAI 互換の `POST /v1/chat/completions` (および `/v1/responses`) を提供し、Grok Build は OpenAI 互換サーバーに対するカスタム モデルをサポートします。この統合により、CodexCommander は表示されているカタログ全体を Grok Build に自動的に登録します。手動による構成編集は必要ありません。

## 自動登録

`~/.grok` が存在する場合、`ccx start` (および `ccx ensure` / `ccx restart`) はマネージド ブロックを `~/.grok/config.toml` に書き込みます。

```toml
# >>> CodexCommander managed block — do not edit (removed by `ccx stop`) >>>
[model.ccx-gpt-5-6-sol]
model = "gpt-5.6-sol"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "codexcommander-loopback"
name = "CodexCommander gpt-5.6-sol"
# ... one [model.ccx-*] table per visible model ...
# <<< CodexCommander managed block <<<
```

- **追加:** フェンスの外側にある独自の設定には決して触れません。最初の前に
既存のファイルに注入すると、1 回限りのバックアップが `~/.grok/config.toml.bak-codexcommander` に書き込まれます。
- **べき等:** すべての `ccx start` (および自動起動が有効な場合は `ccx ensure`) が置き換えられます。
現在のカタログを含むフェンスで囲まれたブロック。
- **分解時に削除:** `ccx stop`、`ccx eject`、`ccx uninstall`、およびグレースフル
非サービスデーモンをシャットダウンすると、フェンスで囲まれたブロックが削除され、ファイルがバイト単位で復元されます。サービス マネージャーの下では、ティアダウンは `ccx stop`/`ccx uninstall` を経由します (サービス モード プロセスは、再生成後も意図的にブロックを保持します)。
- **競合安全:** 独自の `[model.*]` テーブルですでに定義されているエイリアスが尊重されます
(CodexCommander は独自のエントリに接尾辞を付けます);損傷したフェンス (終了マーカーのない開始マーカー) は自動変更を拒否し、手動での修復を要求します。

次に、Grok Build 内のモデルを選択します。

```bash
grok models          # lists ccx-* entries alongside native grok models
grok -m ccx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ccx-anthropic-claude-opus-4-8
```

## 認証メモ

Grok Build では、ループバックでもカスタム モデルに対して空ではない API キーが必要です。挿入されたエントリにはプレースホルダー (`codexcommander-loopback`) が含まれます。CodexCommander はループバック接続のアドミッション キーを無視するため、実際の秘密は関係しません。

**自動登録はループバックのみです。** CodexCommander が非ループバック ホスト (すべてのインターフェイスを公開するワイルドカード `0.0.0.0` および `::` を含む) をバインドする場合、リクエストには実際のアドミッション トークンが必要であり、マネージド ブロックはそれを安全に運ぶことができません。リテラルトークンを書き込むと、シークレットが `~/.grok/config.toml` に設定され、そこで設定した内容が次の `ccx start`/`ensure`/`restart` に上書きされます。したがって、その場合、CodexCommander は何も書き込みません (そして、以前のループバック バインドで残ったブロックはすべて削除します)。また、管理対象マーカーの外側でモデルを自分で設定します。CodexCommander が何をしてもモデルを破壊することはありません。正確なテーブルについては [マニュアルレシピ](#manual-recipe-without-auto-registration) を参照し、`base_url` (`grok` を実行する場所から実際に到達可能なホスト) と `api_key` (`CODEXCOMMANDER_API_AUTH_TOKEN`) の両方を設定します。

ここで `api_key` を `env_key` に置き換えないでください。 `model_provider` が設定されていない場合、解決に失敗した `env_key` はリクエストを停止しません。Grok は xAI セッション トークンに到達し、それをエントリ名が `base_url` に送信します。LAN デプロイメントの場合、これは xAI ではないプレーンテキスト HTTP エンドポイントです。

注入されたモデルごとの `api_key` は、これらのモデルの Grok 資格情報チェーンの最初に位置するため、CodexCommander に対抗する場合は追加の Grok ログインは必要ありません。ネイティブ grok モデルおよび xAI に直接接続するハーネス機能については、通常の `grok login` / `XAI_API_KEY` セットアップを維持します。

## 手動レシピ（自動登録なし）

`~/.grok/config.toml` を自分で管理する場合、または CodexCommander が非ループバック バインド上にある場合は、**直接フィールド**を持つモデルごとのテーブルを `# >>> CodexCommander managed block` マーカーの外側に追加します。

```toml
[model.ccx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "codexcommander-loopback"
```

ネットワーク経由で到達可能なプロキシの場合は、`grok` が実際にダイヤルしてアドミッション トークンを使用できるアドレスに `base_url` を指定します。

```toml
[model.ccx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "chat_completions"
api_key = "your-CODEXCOMMANDER_API_AUTH_TOKEN"
```

エンドポイントの `[model_providers.<id>]` 継承に依存しないでください。Grok Build 0.2.101 では、継承された `base_url` は推論ルーティングに適用されません (リクエストはデフォルトの xAI プロキシにフォールスルーされ、401 で失敗します)。モデルごとのフィールドを正しくルーティングします。

ドットを含むエイリアスを引用符で囲みます。裸の `[model.grok-4.5]` は 3 セグメントのキー パスであり、ID `grok-4.5` ではありません。この理由により、生成されたエイリアスではドットが完全に回避されます。

## 既知の制限事項

- **バックエンドとキープアライブの応答:** CodexCommander は `response.heartbeat` キープアライブを発行します
アップストリーム沈黙中の `/v1/responses` ストリーム。 Grok Build の Responses デコーダは未知のイベント タイプを拒否するため、手動で構成された `api_backend = "responses"` モデルは低速なアップストリームではターン中に失敗する可能性があります。自動登録されたエントリは `api_backend = "chat_completions"` をピン留めしますが、生のハートビート フレームが表示されることはありません。
- **サービスでインストールされた `ccx restart`:** CodexCommander がサービス マネージャーの下で実行される場合、
現在、`ccx restart` はサービスを停止し、アンマネージド プロセスに置き換えます。サービスの永続性 (自動再起動、ログイン時開始) は、次の `ccx service` セットアップまで失われます。また、そのアンマネージド プロセスが終了した場合、次の `ccx start`/`ccx ensure` が更新するまで、マネージド ブロックは無効なプロキシを指す可能性があります。
- **構成読み取りタイミング:** 最初に CodexCommander を起動し、その後 `grok` を起動します。
予測可能な結果。 Grok Build は `~/.grok/config.toml` を監視し、`[model]` テーブルが実際に変更されると (内容で比較すると約 1 秒のデバウンス) 再ロードするため、更新されたブロックは再起動せずに開いているセッションに到達します。 Grok が解析した内容を確認するには、`grok inspect` を実行します。ロードされた設定ソースがリストされ、拒否されたフィールドについて警告が表示されます。解決されたモデルのリストは出力されません。単一の TOML エラーがユーザー設定レイヤー「全体」を無効にすることに注意してください。これが、CodexCommander がファイルをアトミックに書き込む理由です。Grok は書きかけの設定を決して認識しません。
- **カタログの更新:** フェンスで囲まれたブロックには、射出時のカタログが反映されます。後
プロバイダーまたはモデルを追加するには、`ccx ensure` を実行して (またはプロキシを再起動して) 更新します。

---
title: オープンコード
description: オープンコードからルーティングされたモデルを使用します。CodexCommander はランタイム プロバイダー ブロックを挿入し、独自のオープンコード設定をそのまま残します。
---

opencode は、環境変数ではなくマージされた JSON 構成レイヤーからプロバイダーを読み取るため、挿入する `ANTHROPIC_BASE_URL` スタイルのスロットはありません。 `ccx opencode` はそのギャップを橋渡しします。プロキシが実行されていることを確認し、表示されているカタログからプロバイダー ブロックを構築し、OpenCode のインライン ランタイム層 (`OPENCODE_CONFIG_CONTENT`) を通じてそれを挿入します。

## クイックスタート

```bash
ccx opencode
```

これにより、プロキシが確実に実行され、そのプロセスに挿入された生成された `provider.codexcommander` ブロックのみを使用してオープンコードが起動されます。追加の引数は `ccx opencode run "hello"` を通過します。

ルーティングされたモデルは、ピッカーの `codexcommander` プロバイダーの下に表示されます。

```text
codexcommander/kiro/glm-5
codexcommander/gpt-5.6-sol      # native slugs stay unprefixed
```

## あなた自身の設定は決して変更されません

ランチャーは、`~/.config/opencode/opencode.json`、プロジェクト `opencode.json` / `opencode.jsonc`、またはその他のディスク上の構成レイヤーをコピーしたり書き換えたりしません。既存のプロバイダー、エージェント、キーバインド、MCP エントリ、および相対的な `{file:…}` 参照は元のファイルから解決され続けますが、`provider.codexcommander` オーバーライドを検出するためにグローバルまたはプロジェクト設定を読み取ることがあります。

この起動の場合のみ、CodexCommander は、OpenCode のインライン ランタイム層を介して、生成された `provider.codexcommander` ブロックを追加します。そのレイヤーは、グローバル/カスタム/プロジェクト設定の後にマージされ、子プロセスの競合するキーのみをオーバーライドします。

|レイヤー | `ccx opencode` での動作 |
| --- | --- |
|グローバル / カスタム / プロジェクト構成 |書き込んだとおりにディスク上に残ります |
|インライン ランタイム (`OPENCODE_CONFIG_CONTENT`) |生成された `provider.codexcommander` ブロックのみを受信します。
|相対 `{file:…}` パス |最初に定義した設定ファイルに対して引き続き解決します。

グローバルまたはプロジェクト設定でも `provider.codexcommander` が定義されている場合、ランチャーは情報メモを出力します。`ccx opencode` のランタイム層がその起動に対してそれをオーバーライドします。

## ダッシュボードの永続接続（任意）

通常の OpenCode、エディター統合、または Desktop のワンクリック起動で使うには、CodexCommander
ダッシュボードの **Integrations** で **Apply connection** を選びます。これは `ccx opencode` とは
別の経路です。

- `XDG_CONFIG_HOME` 配下（通常は `~/.config/opencode/`）のアクティブなグローバル設定を選び、
  `opencode.jsonc` が存在すればそれを、なければ `opencode.json` を使います。
- JSONC 編集は `provider.codexcommander` だけを変更するため、コメント、書式、他のプロバイダー、
  エージェント、MCP、無関係なキーは保持されます。
- プロキシのアドミッション トークンは CodexCommander の保護された状態に残り、OpenCode 設定には
  `{file:/absolute/path}` 参照だけが入ります。OpenCode の認証ストアは読みません。
- **Always keep OpenCode connected** はデフォルトでオフで、明示的に有効にした後だけプロキシ起動や
  表示カタログ変更時にこの管理ブロックを更新します。

journal が正確な復元を安全と確認した場合、**Restore** は元のバイト列を正確に復元します。それ以外では、
ダッシュボードは他のユーザー編集を保持したまま管理対象の `provider.codexcommander` だけを外科的に
復元または削除します。**Open OpenCode** は OpenCode Desktop をワンクリックで起動します。CLI だけの
場合は、ディスクを変更しない `ccx opencode` を使用してください。

## ブロックを独自の設定に入れる

`ccx opencode` は 1 回の起動に対してのみプロバイダー ブロックを挿入します。上のダッシュボード永続接続を
適用していない場合、プレーン `opencode` はまだプロキシについて何も知りません。プレーンな `opencode`
から、またはランチャーを経由しないエディター拡張機能からルーティングされたモデルを利用できるようにしたい場合、`ccx export` は同じプロバイダー ブロックを出力して、独自の設定にマージします。

```bash
ccx export --client opencode
```

プロキシが実行されている必要があります。このコマンドは、構成、正規の宛先 (`~/.config/opencode/opencode.json`、またはそれが設定されている場合は `XDG_CONFIG_HOME` の下)、マージ警告、および env エクスポート行を出力します。そのファイルには決して触れません。上記のセクションはそのままであり、ブロックを設定に移動するのは明示的な行為です。

:::caution[マージし、決して置き換えないでください]
`provider.codexcommander` ブロックを既存の設定にマージします。ファイル全体をエクスポートされたファイルで置き換えると、他のプロバイダー、エージェント、キーバインド、および MCP エントリが破壊されます。 `ccx export --out` はまさにこの理由で既存のファイルの上書きを拒否するため、`--out` をスクラッチ パスに指定し、ブロックを次のようにコピーします。

```bash
ccx export --client opencode --out ~/codexcommander-opencode.json
```
:::

ランチャーのランタイム ブロックとは異なり、マージされたブロックは静的なスナップショットであり、カタログに従いません。プロバイダーを追加するか、モデルの可視性を変更した後、`ccx export` を再実行します。

マージしたら、オープンコードを起動する前にアドミッション キーをエクスポートします。プロキシがループバック上にある場合を除き、何も必要ありません。

```bash
export CODEXCOMMANDER_OPENCODE_API_KEY=<your key>
```

## アドミッションキーがディスクに書き込まれません

プロキシが API キーを必要とする場合、インライン ランタイム設定にはシークレットではなくオープンコードの `{env:…}` 参照が含まれます。ループバック バインドでは、その参照を `apiKey` として使用します。非ループバック バインドは `x-codexcommander-api-key` を介してのみ送信するため、プロキシ アドミッションはアップストリームの `Authorization` ヘッダーから分離されたままになります。

ループバックの例:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:CODEXCOMMANDER_OPENCODE_API_KEY}"
}
```

非ループバックの例:

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-codexcommander-api-key": "{env:CODEXCOMMANDER_OPENCODE_API_KEY}"
  }
}
```

実際の値は、子プロセス環境を介してのみ渡されます。 `CODEXCOMMANDER_API_AUTH_TOKEN` が優先され、次に強化されたサービス トークン ファイル、次に設定された API キーが優先されます。これは、非ループバック バインドに必要なものです。

ループバック バインド (`127.0.0.1`、デフォルト) は何も認証しないため、`{env:…}` 参照は不活性であり、変数を設定しないままにすることができます。 `hostname` がループバックを超えて設定されている場合にのみ問題になります。 [リモートアクセス](/reference/configuration/#remote-access)を参照してください。このアドミッション キーは CodexCommander 独自のものであり、[プロバイダー](/guides/providers/) で構成されたアップストリーム プロバイダー キーとは無関係です。

## 元に戻す

一時的な `ccx opencode` では元に戻す必要はありません。OpenCode 設定ファイルを変更しないためです。
ダッシュボード接続は **Integrations** の **Restore** で戻します。journal が許可すれば元のバイト列を
正確に復元し、それ以外では管理対象プロバイダーだけが外科的に復元されます。

## モデルの制限

`limit.context` は、カタログが権限のあるコンテキスト ウィンドウを報告する場合にのみ書き込まれます。そうでない場合、`limit` ブロック全体が省略され、opencode は独自のデフォルトを保持します。

opencode のスキーマは、`output` のない `context` を含む `limit` ブロックを拒否し、カタログにはモデルごとに権限のある出力フィールドがないため、`32000` の `output` バジェットが一緒に出力され、コンテキスト ウィンドウに固定されるため、コンテキストの小さいモデルには `output > context` が与えられません。この数値はスキーマを満たすために存在します。これは、特定のモデルの真の最大値について主張するものではありません。

`codexcommander` プロバイダー ブロックは起動のたびに再生成されるため、内部で行われたモデルごとの調整は存続しません。代わりに、独自のプロバイダー キーの下にカスタム エントリを保持します。

## 要件

opencode が `PATH` にインストールされている必要があります。

```bash
npm install -g opencode-ai
```

---
title: Интеграция с Codex
description: Как CodexCommander внедряется в Codex, синхронизирует каталог моделей, устанавливает shim'ы и чисто восстанавливает исходное состояние.
---

CodexCommander заставляет Codex маршрутизировать запросы через прокси, редактируя две сущности,
которые читает Codex: его конфигурацию (`$CODEX_HOME/config.toml`, по умолчанию
`~/.codex/config.toml`) и его каталог моделей. Все правки идемпотентны и обратимы.

Прокси предоставляет один «голый» маршрут входа Codex `openai` с режимами аккаунтов Pool
(по умолчанию) и Direct, а также `openai-apikey/<model>` для настроенного API-ключа. Pool
включает основной и добавленные аккаунты; Direct использует только bearer текущего вызывающего
или основного входа. Маршруты не откатываются друг в друга.

## Внедрение в конфигурацию

`ccx init`, `ccx start` и `ccx sync` вызывают injector. На loopback-привязке по умолчанию он
сохраняет встроенный id провайдера Codex `openai` и направляет его на CodexCommander:

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/codexcommander-catalog.json"
# Auto-injected by CodexCommander
openai_base_url = "http://127.0.0.1:10100/v1"

# только если fastMode задан; без него таблица [features] не создаётся
[features]
fast_mode = true
```

Инжектируемый `fast_mode` следует трёхзначной настройке `fastMode`: `true` записывает
`fast_mode = true`, `false` — `fast_mode = false`, а при отсутствии настройки существующий
`fast_mode` сохраняется без изменений, и таблица `[features]` не добавляется.

Прокси по умолчанию слушает порт `10100` и обслуживает `POST /v1/responses`,
`POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
`GET /v1/models`, `GET /healthz` и management surface `/api/*`.

### Встроенная генерация изображений (`image_gen`)

Встроенный tool Codex `image_gen` идёт не через `/v1/responses` — расширение codex-rs напрямую
отправляет POST на `{base_url}/images/generations` (или `/images/edits`, если приложены
reference-image), используя тот же bearer ChatGPT, что и для чата. Поскольку внедрённый
`base_url` указывает на CodexCommander, прокси ретранслирует эти вызовы в upstream OpenAI.

Это отдельно от [Image Bridge](/guides/image-bridge/), который активируется только тогда, когда
**Responses**-ход перечисляет hosted tool `image_generation`, а в качестве модели выбрана
не-OpenAI модель. Отдельные вызовы `/images/generations` в этот bridge не попадают.

- **Один mode-aware forward candidate:** Pool выбирает подходящий основной или добавленный
  аккаунт; Direct использует OAuth bearer вызывающей стороны. Настроенный режим одинаково
  применяется и к image-запросу.
- **Провайдер OpenAI по API-ключу:** используется только тогда, когда ни один forward-candidate
  не владеет ошибкой аутентификации. Сломанный или истёкший Pool credential никогда не
  маскируется отдельно тарифицируемым API-вызовом.
- **Явный custom provider:** задайте `images.provider` как id custom-провайдера с ключом и
  адаптером `openai-responses`, чей endpoint реализует OpenAI Images API. При явном выборе
  провал жёсткий: никакого fallback на другой платный upstream нет. Id провайдера, управляемые
  registry, здесь не принимаются; если хотите использовать встроенные уровни OpenAI, опустите
  `images.provider`.
- **Fallback Google Antigravity (CCA):** если не настроен ни один OpenAI forward-candidate и ни
  один keyed provider, `/v1/images/generations` (но не `/images/edits`) переходит на endpoint
  Antigravity **Cloud Code Assist** с моделью `gemini-3.1-flash-image`. Этот fallback также
  включается после провала разрешения OpenAI auth (например, если credential ChatGPT просрочен
  или отсутствует), а не только в ситуации полного отсутствия кандидата OpenAI. Для этого нужен
  `ccx login google-antigravity`; OAuth-токен отправляется только на закреплённый registry-host
  CCA, а не на override `baseUrl` из конфигурации. Ответ возвращается в той же форме
  `{created, data:[{b64_json}]}`, которую ожидает Codex.
- **Ничего из этого:** прокси возвращает понятную ошибку вместо общего 404. Маршрутизируемые
  провайдеры (Cursor, Gemini, Kiro и т. п.) не могут обслуживать relay для инструмента
  `image_generation`; если вы вообще не хотите предлагать этот tool, отключите его в Codex через
  `codex features disable image_generation` (`[features] image_generation = false` в `config.toml`).

Объявление tool всё равно идёт вместе с Responses-запросом модели. Для Responses-провайдеров по
API-ключу CodexCommander понижает приватное пространство имён Codex `image_gen` до безопасного для
upstream alias `image_gen__<inner-name>` (например, `image_gen__imagegen`). Когда этот рабочий
alias заменяет клиентское объявление, CodexCommander удаляет дублирующее hosted-объявление
`image_generation`. Перед тем как Codex увидит вызов, proxy отображает function call обратно в
явное пространство имён `image_gen`, а при последующем replay истории вверх по потоку снова
кодирует нативный вызов. Так client-side image generation остаётся вызываемой даже на
public-compatible upstream'ах, которые резервируют это пространство имён или отвергают function
name с точками. Режим ChatGPT forward остаётся нетронутым и сохраняет нативную форму Responses
Lite.

Если у вас есть собственный OpenAI-compatible gateway, настройте выделенного провайдера и
выберите его только для standalone Images-запросов:

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

Custom-endpoint должен принимать `POST /v1/images/generations` и `/v1/images/edits` и возвращать
форму ответа OpenAI Images, которую ожидает Codex. Настроенный ключ провайдера заменяет любой
caller bearer перед отправкой upstream-запроса.

> **Note:** это относится только к relay инструмента Codex `image_generation`
> (`/images/generations`). Способные генерировать изображения модели Gemini выдают inline-image
> нативно через адаптер `google` (через `responseModalities: ["TEXT", "IMAGE"]`) и к этому relay
> не относятся — см. [Adapters](/reference/adapters/#google).

Если `hostname` не loopback, Codex должен отправлять сгенерированный заголовок API-аутентификации.
Поэтому injector использует выделенного провайдера:

```toml
# root keys
model_provider = "codexcommander"
model_catalog_json = "/absolute/path/to/codexcommander-catalog.json"

# appended at the end of the file
# Auto-injected by CodexCommander
[model_providers.codexcommander]
name = "CodexCommander Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-codexcommander-api-key" = "CODEXCOMMANDER_API_AUTH_TOKEN" }
# supports_websockets = true   # only when config.websockets is true
```

Когда маршрутизацией владеет CodexCommander, оба режима пишут `$CODEX_HOME/codexcommander.config.toml` как
reference/fallback-конфиг. На loopback в нём лежат root key, которые можно вручную влить обратно,
если автоматическое внедрение убрали; на не-loopback — форма с выделенным провайдером. Режим
external-provider этот профиль не трогает.

:::caution
Root key вроде `openai_base_url`, `model_provider` и `model_catalog_json` **обязаны** располагаться
до первого заголовка `[table]`. Injector гарантирует это размещение, удаляет собственные
устаревшие или дублирующиеся копии и никогда не перезаписывает user-owned root `openai_base_url`;
если такой ключ уже существует, sync обновляет каталог, но сообщает, что routing не был внедрён.
:::

## Общий каталог моделей

Codex CLI, TUI, App и SDK читают один и тот же Codex home. CodexCommander определяет этот каталог из
`CODEX_HOME`, а если он не задан — из `~/.codex`, и управляет файлами:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/codexcommander.config.toml
$CODEX_HOME/codexcommander-catalog.json
$CODEX_HOME/models_cache.json
```

В WSL, если `CODEX_HOME` не задан и Linux-файл `~/.codex/config.toml` отсутствует, CodexCommander
дополнительно проверяет, нет ли единственного Windows-home Codex Desktop в
`/mnt/c/Users/*/.codex/config.toml`. Если существует ровно один такой кандидат, используется его
каталог, чтобы режим app-server в WSL и Windows Codex Desktop разделяли одни и те же config- и
auth-файлы. Чтобы переопределить это обнаружение, задайте `CODEX_HOME` явно.

На Windows оболочка Orca может одновременно задавать `CODEX_HOME` и `ORCA_CODEX_HOME` на bundled
runtime-home Orca, тогда как приложение ChatGPT/Codex всё ещё читает `%USERPROFILE%\\.codex`.
`ccx status` и `ccx doctor` предупреждают именно об этом рассогласовании и печатают замаскированные
целевые пути. Если фоновая служба была установлена из такой оболочки Orca, сначала удалите её из
исходной оболочки, затем перенаправьте `CODEX_HOME` на home приложения, уберите `ORCA_CODEX_HOME`,
повторите sync/restore и снова установите службу.

В режиме выделенного провайдера `requires_openai_auth = true` держит account-gated surface App/TUI
в согласии с нативным Codex. CodexCommander также обслуживает `/v1/responses` по WebSocket.
Выделенный провайдер объявляет `supports_websockets = true` только когда `"websockets": true`; на
loopback встроенный провайдер Codex может сначала пробовать WebSocket, и отключённый прокси
ответит `426`, после чего Codex откатится на HTTP/SSE.

## Синхронизация каталога моделей

Codex показывает модели из каталога на диске (`$CODEX_HOME/codexcommander-catalog.json` по
умолчанию). При старте и при `ccx sync` CodexCommander:

1. **Создаёт резервную копию** исходного каталога один раз в
   `~/.codexcommander/catalog-backup-<catalog-id>.json` (чтобы «feature»-правки были обратимы).
2. **Получает** живые каталоги моделей подходящих провайдеров (кэш примерно на 5 минут; при
   ошибке использует последний успешный список, затем настроенный `models[]`). У forward auth нет
   model-endpoint'а, а Cursor использует свой RPC `GetUsableModels`, а не `/models`.
3. **Сливает** маршрутизируемые модели как namespaced-записи (`provider/model`), клонированные из
   шаблона нативного каталога Codex, чтобы строгий парсер Codex принимал их.
4. **Фильтрует** `config.disabledModels` и любой непустой allowlist `selectedModels` у провайдера.
5. **Переупорядочивает** записи так, чтобы featured model'и шли первыми (см. ниже), и затем
   записывает объединённый каталог обратно.

У маршрутизируемых записей каталога идентичность GPT-5 также переписывается на настоящее имя
вышестоящей модели. Элементы управления рассуждениями берутся из метаданных провайдера и модели
по шкале Codex `low | medium | high | xhigh | max | ultra`; неподдерживаемые значения
сопоставляются или ограничиваются перед запросом к вышестоящему провайдеру.

### Пользовательские display-name моделей

У custom-модели может быть человекочитаемый **display name**, который переопределяет метку в
picker'е Codex, не меняя саму маршрутизацию. Display name отображается только в поле
`display_name` записи каталога — routing slug (`<provider>/<model>`), порядок разрешения alias,
провайдер и marketing-name нативных моделей OpenAI остаются без изменений.

Добавить display name можно из CLI (если прокси запущен, каталог синхронизируется сразу):

```bash
ccx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

Удалённые клиенты Codex могут получить тот же сгенерированный каталог через management API (с тем
же admission token, что и для других маршрутов `/api/*`):

```bash
dest="${CODEX_HOME:-$HOME/.codex}/codexcommander-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-codexcommander-api-key: $CODEXCOMMANDER_ADMIN_AUTH_TOKEN" \
  "https://proxy.example.com/api/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ccx sync-cache
```

Ответ — это сырой документ `codexcommander-catalog.json` (без credential'ов провайдеров). Если
доступен заголовок `x-codexcommander-codex-version`, он сообщает версию рантайма Codex на сервере,
чтобы клиенты могли заметить version skew.

Display name можно задать или отредактировать и через management API
(`POST /api/custom-models`, `PUT /api/custom-models/<id>` с полем `displayName`) и через
веб-дашборд. Символ `/` запрещён, потому что он столкнулся бы с разделителем routed-slug.

Display name — это **только отображение, и оно устойчиво к перегенерации**. Каждый `ccx sync` и
каждое обновление каталога заново выводят маршрутизируемые записи из `config.json`
(включая `customModels`), поэтому настроенное имя накладывается снова и не «дрейфует» обратно к
routed slug. Управляемый сервис тоже пытается выполнить этот sync вскоре после bind'а прокси.
Если такой best-effort sync при старте не удался, например во время offline-login, сохраняется
предыдущий каталог, а следующий успешный `ccx sync` снова применит настроенное имя. Настоящие
upstream native name'ы (например, `gpt-5.6-sol` → "GPT-5.6-Sol") приходят из закреплённого
upstream snapshot и никогда не перекрываются пользовательским display name.

### Внешние provider manager'ы

Если `config.toml` уже выбирает провайдера, отличного от `openai` или `codexcommander`, CodexCommander
оставляет файл без изменений и пропускает запись profile, обновление catalog/cache и синхронизацию
истории Codex. Инструменты, управляющие custom-провайдером,
часто помечают существующие сессии своим provider id; замена активного id может привести к тому,
что рабочие сессии просто исчезнут из history view Codex. Та же защита действует всегда, когда
активен внешний провайдер.

Держите владельцем конфигурации провайдера Codex только один инструмент. Если вы хотите
использовать CodexCommander позади уже существующего provider manager'а, направьте этот провайдер на
`http://127.0.0.1:10100/v1` с passthrough Responses (`wire_api = "responses"` в TOML Codex), а
не через перевод в Chat Completions. Когда включена proxy API auth, передавайте и
`x-codexcommander-api-key` из `CODEXCOMMANDER_API_AUTH_TOKEN`, то есть ровно так, как в форме
не-loopback-провайдера выше. Чтобы снова дать CodexCommander самому внедрить routing, сначала верните
Codex на встроенный провайдер `openai` и удалите любой user-owned root `openai_base_url`, после
чего снова выполните `ccx start`.

### Устранение проблем с каталогом

Если модель не появляется в Codex или порядок/видимость каталога выглядят неверно, проверяйте по
порядку:

1. **`selectedModels`** у провайдера — непустой allowlist показывает Codex только эти id;
   пустой или отсутствующий список показывает все обнаруженные модели. Id, которого нет в
   allowlist, никогда не попадёт в каталог.
2. **`disabledModels`** (верхний уровень) — скрывает модели и из каталога, и из `/v1/models`, а у
   голых нативных GPT-slug устанавливает `visibility: "hide"`.
3. **`liveModels: false` и пустой `models`** — если живое обнаружение выключено, а `models` пуст
   или отсутствует, CodexCommander не показывает ни одной маршрутизируемой модели этого провайдера.
4. **Cursor `GetUsableModels`** — адаптер Cursor получает модели через protobuf RPC
   `GetUsableModels`, а не через `/models`, поэтому изменение на стороне Cursor может менять
   видимые id независимо от остальных провайдеров.
5. **Кэш и `ccx sync`** — живые каталоги кэшируются примерно на пять минут (`modelCacheTtlMs`,
   по умолчанию `300000`). Выполните `ccx sync`, чтобы принудительно обновить список и немедленно
   переписать каталог.
6. **Запущенный Codex `app-server`** — переписать каталог на диске недостаточно, если
   долгоживущий `app-server` Codex (Desktop / CLI background host) держит в памяти старый список.
   `ccx sync` и `ccx sync-cache` предупреждают, когда находят такие процессы. Перезапустите их
   через `ccx sync --restart-codex` (или остановите подходящие процессы `app-server` вручную), а
   затем дайте Codex создать их заново.

:::caution[Другие локальные writer'ы]
Записи каталога (`codexcommander-catalog.json`, `config.toml`) атомарны **только внутри** CodexCommander, то
есть защищают лишь от полузаписанных файлов, когда гоняются два writer'а самого CodexCommander. Это
**не** мешает другому локальному процессу, file watcher'у или sync-agent'у переписать видимость или
порядок каталога после того, как CodexCommander уже записал свой вариант. У Codex есть отдельный
`models_cache.json`, и он может обновить его независимо, меняя видимый список без перезаписи
`codexcommander-catalog.json`. Если модели неожиданно «перещёлкиваются», пока прокси работает,
остановите или перенастройте конкурирующих writer'ов, а затем выполните `ccx sync` — это риск
внешнего writer'а, а не подтверждённый дефект CodexCommander.
:::

## Ошибки подключения к прокси

Если Codex несколько раз пробует и затем завершается ошибкой вроде
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
— или Claude Code сообщает о похожем connection failure — прокси CodexCommander просто не запущен:
ничто не слушает настроенный порт, и клиент показывает эту сырую ошибку соединения как есть.
Перезапустите прокси:

```bash
ccx start              # foreground
ccx service install    # persistent: auto-starts on login and respawns on crash
```

`ccx status` показывает, запущен ли прокси, и печатает ту же подсказку о перезапуске, если он не
работает; `ccx doctor` сообщает, насколько безопасен перезапуск (покрытие service/shim).

## Picker подагентов

Синхронизация каталога делает выбранные модели подагентов доступными Codex; порядок в picker'е
описан в [picker'е моделей Codex App](/guides/codex-app-models/#subagent-selection), а поведение
v1/base/v2 при делегировании и fallback — в
[Поверхности подагентов](/guides/sub-agent-surface/).

## Прогрев аккаунтов Codex

Когда аккаунт ChatGPT добавляется в пул аккаунтов Codex, CodexCommander проверяет его до сохранения
небольшим streaming-запросом в backend Codex Responses. Запрос использует настоящий массив
Responses item'ов (`input: [{ type: "message", ... }]`), ждёт `response.completed` и по умолчанию
использует `gpt-5.4-mini`. Если эта модель отвечает HTTP 400, выполняется повтор с `gpt-5.5`;
структурированные детали upstream-ошибки показываются без раскрытия сырых тел ответа. Фоновая
перепроверка отделена от этого процесса и по умолчанию выключена; она запускается только когда
включён Token Guardian, у `chatgpt` выставлена политика refresh `proactive`, а
`tokenGuardian.codexWarmupEnabled` равен true.

## Восстановление нативного Codex

CodexCommander не запирает вас внутри себя. **`ccx stop` — это единственная команда, которая полностью
возвращает нативный Codex**: она останавливает прокси, останавливает фоновую службу, если она
установлена, и убирает все внедрённые строки и маршрутизируемые записи каталога, так что обычный
`codex` снова работает так, будто CodexCommander никогда не существовал:

```bash
ccx stop       # stop the proxy + service, restore native Codex
ccx restore    # restore without stopping  (alias: ccx eject)
ccx restore back # point plain Codex at the running proxy again
```

Когда CodexCommander работает как управляемая [фоновая служба](/reference/cli/#ccx-service), он
устанавливает `CCX_SERVICE=1`, чтобы service-driven restart **не** дёргал конфигурацию Codex —
только явный `ccx stop` / `ccx service stop` восстанавливает нативный Codex.

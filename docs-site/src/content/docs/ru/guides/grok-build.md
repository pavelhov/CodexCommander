---
title: Grok Build
description: Используйте любую модель, маршрутизируемую CodexCommander, из CLI xAI Grok Build — пока прокси работает, модели автоматически регистрируются в ~/.grok/config.toml.
---

CodexCommander отдаёт OpenAI-совместимый `POST /v1/chat/completions` (и `/v1/responses`) на своём
локальном порту, а Grok Build поддерживает custom-модели поверх OpenAI-совместимых серверов.
Начиная с этой интеграции, CodexCommander автоматически регистрирует весь свой видимый каталог в
Grok Build — вручную редактировать конфигурацию не нужно.

## Авторегистрация

Когда существует `~/.grok`, `ccx start` (а также `ccx ensure` и `ccx restart`) записывает
управляемый блок в `~/.grok/config.toml`:

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

- **Additive:** ваша собственная конфигурация вне fenced-блока никогда не трогается. Перед первым
  внедрением в уже существующий файл создаётся одноразовая резервная копия
  `~/.grok/config.toml.bak-codexcommander`.
- **Idempotent:** каждый `ccx start` (и `ccx ensure`, когда включён автозапуск) заменяет fenced-блок
  текущим каталогом.
- **Removed on teardown:** `ccx stop`, `ccx eject`, `ccx uninstall` и корректное завершение
  не-service-демона удаляют fenced-блок и побайтно восстанавливают ваш файл. Под service manager
  teardown выполняется через `ccx stop`/`ccx uninstall` (процессы service-mode намеренно
  сохраняют блок между respawn'ами).
- **Conflict-safe:** alias, уже объявленные в ваших `[model.*]`, уважаются (CodexCommander добавляет
  суффиксы к своим записям); повреждённый fence (маркер начала без маркера конца) запрещает любые
  автоматические изменения и просит ручного исправления.

После этого выберите модель в Grok Build:

```bash
grok models          # lists ccx-* entries alongside native grok models
grok -m ccx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ccx-anthropic-claude-opus-4-8
```

## Замечание об аутентификации

Grok Build требует непустой API-ключ для custom-моделей даже на loopback. Внедряемые записи несут
placeholder (`codexcommander-loopback`) — CodexCommander игнорирует admission key для loopback-подключений,
так что реальный секрет тут не используется.

**Авторегистрация работает только на loopback.** Когда CodexCommander привязывается к не-loopback-хосту
— включая wildcard `0.0.0.0` и `::`, открывающие все интерфейсы, — запросам нужен ваш настоящий
admission token, а управляемый блок не может безопасно его хранить. Запись буквального токена
поместила бы ваш секрет в `~/.grok/config.toml` и перезаписывала бы установленное вами значение
при каждом `ccx start`/`ensure`/`restart`. Поэтому в этом случае CodexCommander вообще ничего не
записывает (и удаляет блок, оставшийся от прежней loopback-привязки), а вы настраиваете модели
сами, вне managed-маркеров, где CodexCommander ничего не сможет затереть. Точный пример таблицы см. в
[ручном рецепте](#manual-recipe-without-auto-registration), а в `base_url` укажите хост, который
действительно достижим из того места, где вы запускаете `grok`, и в `api_key` укажите
`CODEXCOMMANDER_API_AUTH_TOKEN`.

Не заменяйте здесь `api_key` на `env_key`. Если `model_provider` не задан, `env_key`, который не
разрешился, не останавливает запрос — Grok откатывается к вашему session token xAI и отправляет
его на любой `base_url`, указанный в записи, а для LAN-развёртывания это plaintext HTTP-endpoint,
который не является xAI.

Внедрённый `api_key` на уровне модели стоит первым в цепочке учётных данных Grok для этих моделей,
поэтому ходам через CodexCommander не нужен дополнительный `grok login`. Обычную настройку
`grok login` / `XAI_API_KEY` сохраняйте для нативных grok-моделей и любых harness-функций, которые
напрямую обращаются к xAI.

## Ручной рецепт без авторегистрации

Если вы управляете `~/.grok/config.toml` сами — либо CodexCommander привязан не к loopback, —
добавляйте таблицы по одной модели с **прямыми полями**, вне маркеров
`# >>> CodexCommander managed block`:

```toml
[model.ccx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "codexcommander-loopback"
```

Для прокси, доступного по сети, укажите в `base_url` адрес, до которого `grok` реально может
дозвониться, и используйте свой admission token:

```toml
[model.ccx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "chat_completions"
api_key = "your-CODEXCOMMANDER_API_AUTH_TOKEN"
```

Не полагайтесь на наследование `[model_providers.<id>]` для endpoint'а: по состоянию на Grok Build
0.2.101 унаследованный `base_url` не применяется к маршрутизации inference (запросы откатываются к
прокси xAI по умолчанию и падают с 401). Прямые поля на уровне модели маршрутизируются правильно.

Любой alias, содержащий точку, берите в кавычки: голый `[model.grok-4.5]` — это путь из трёх
сегментов, а не id `grok-4.5`. Сгенерированные alias по этой причине вообще избегают точек.

## Известные ограничения

- **Responses backend и keep-alive:** во время тишины upstream CodexCommander посылает keep-alive
  `response.heartbeat` в потоках `/v1/responses`. Декодер Responses в Grok Build отвергает
  неизвестные типы событий, поэтому вручную настроенная модель с
  `api_backend = "responses"` может оборваться посреди хода на медленных upstream. Автоматически
  зарегистрированные записи жёстко используют `api_backend = "chat_completions"`, где сырые
  heartbeat-кадры никогда не видны.
- **`ccx restart`, установленный как service:** когда CodexCommander работает под service manager,
  `ccx restart` сейчас останавливает службу и заменяет её неуправляемым процессом — persistence
  службы (автоперезапуск, старт при логине) теряется до следующего `ccx service`, а если этот
  неуправляемый процесс погибнет, managed block может указывать на уже мёртвый прокси, пока
  следующий `ccx start`/`ccx ensure` не обновит его.
- **Время чтения конфигурации:** для наиболее предсказуемого поведения сначала запускайте
  CodexCommander, а затем `grok`. Grok Build отслеживает `~/.grok/config.toml` и перезагружает его,
  когда секция `[model]` действительно меняется (порядка секунды debounce, сравнение по
  содержимому), поэтому обновлённый блок доходит до уже открытой сессии без перезапуска. Чтобы
  проверить, что именно разобрал Grok, выполните `grok inspect`: он перечисляет источники
  конфигурации и предупреждает о полях, которые отверг. Список разрешённых моделей при этом не
  печатается. Учтите, что одна TOML-ошибка делает недействительным *весь* пользовательский слой
  конфигурации, поэтому CodexCommander пишет файл атомарно — Grok никогда не увидит полузаписанный
  `config.toml`.
- **Обновления каталога:** fenced-блок отражает каталог на момент внедрения. После добавления
  провайдеров или моделей выполните `ccx ensure` (или перезапустите прокси), чтобы его обновить.

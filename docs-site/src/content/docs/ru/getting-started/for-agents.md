---
title: Быстрый старт для агентов
description: Установите и используйте CodexCommander из агентного или сценарного терминала.
---

Эта страница предназначена для ИИ-агента или пользователя, который работает из терминала через
сценарии. Она сосредоточена на командах, кодах выхода и безопасной headless-работе. Если вам нужен
сценарий для человека, откройте [Быстрый старт](/getting-started/quickstart/). Дашборд остаётся
доступен для интерактивной настройки; см. [Веб-дашборд](/guides/web-dashboard/).

## Настройте CodexCommander

Используйте существующий исходный checkout. Пакет в реестре сейчас не опубликован:

```bash
bun install
bun run build:gui
bun run src/cli/index.ts --version
```

Выберите один из способов запуска прокси:

```bash
# Foreground: blocks this terminal until stopped.
bun run src/cli/index.ts start

# Background: installs or updates the service, then starts it.
bun run src/cli/index.ts service
```

Запустите `ccx init` в интерактивном терминале. Если `ccx start` уже занимает передний план,
используйте второй терминал:

```bash
bun run src/cli/index.ts init
```

Далее любую команду `ccx <args>` в этом checkout можно выполнить как `bun run src/cli/index.ts <args>`.

Мастер записывает `$CODEXCOMMANDER_HOME/config.json` (обычно `~/.codexcommander/config.json`). Он также может
вставить адрес прокси в `config.toml` Codex и установить необязательный shim автозапуска Codex.
`ccx init` никогда не запускает прокси. Для полностью неинтерактивной настройки вместо мастера
настройте провайдеров через `ccx provider add`, как показано ниже.

## Проверьте headless-установку

Используйте эти read-only проверки в сценариях и агентных запусках:

```bash
ccx status
ccx doctor
ccx health --json
```

`ccx status` сообщает состояние прокси и службы. `ccx doctor` диагностирует локальную среду,
сеть, рантайм Codex и проблемы со здоровьем аккаунтов. `ccx health` завершаетcя с кодом `0`,
когда прокси исправен, и с `1` в противном случае; `--json` возвращает структурированный вывод.

Команды, работающие через management API, например `ccx combo set`, обращаются к живому прокси.
Если живой прокси не найден или API недоступен, CLI трактует это как ошибку `503` и завершаетcя с
ненулевым кодом. Перед повторной попыткой запустите прокси в foreground или как фоновую службу.
Полные поверхности команд и endpoint'ов описаны в [справочнике CLI](/reference/cli/) и
[Management API](/reference/management-api/).

## Добавляйте провайдеров и combo без дашборда

Registry-провайдеры можно добавлять по имени. Например, эта команда добавляет пресет Anthropic с
API-ключом и делает его провайдером по умолчанию:

```bash
ccx provider add anthropic-apikey \
  --api-key "$ANTHROPIC_API_KEY" \
  --set-default
```

`ccx provider add` записывает локальную конфигурацию. Добавьте `--sync`, если живой прокси уже
работает и вы хотите сразу синхронизировать модели в Codex; иначе позже выполните `ccx sync`.
Пользовательские провайдеры, которых нет в registry, требуют одновременно `--adapter` и
`--base-url`.

Когда все целевые провайдеры настроены и прокси запущен, создайте failover-combo:

```bash
ccx combo set main \
  --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol \
  --strategy failover
```

Цели используют синтаксис `provider/model` и перечисляются через запятую. Результирующая
виртуальная модель — `combo/main`. Подробности о стратегиях, весах, sticky-маршрутизации и
поведении при сбоях см. в [Combos](/guides/combos/).

## Удалённые и LAN-привязки

Привязка к loopback по умолчанию не требует API-токена. Для не-loopback-привязки, например
`0.0.0.0`, требуется `CODEXCOMMANDER_API_AUTH_TOKEN`; без него прокси откажется запускаться. Задайте
эту переменную перед `ccx start` или перед `ccx service install`, чтобы служба тоже её получила:

```bash
export CODEXCOMMANDER_API_AUTH_TOKEN="your-secret-token"
ccx service install
```

После этого клиенты должны аутентифицировать запросы как к management API, так и к модели.
Прежде чем открывать CodexCommander за пределы локальной машины, прочитайте правила удалённого доступа
в разделе [Конфигурация](/reference/configuration/).

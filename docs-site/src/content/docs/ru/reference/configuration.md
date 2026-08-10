---
title: Справочник конфигурации
description: Где CodexCommander хранит конфигурацию, как применяются правки и где искать ссылки на все домены настроек.
---

CodexCommander хранит постоянную конфигурацию в `$CODEXCOMMANDER_HOME/config.json`, обычно в
`~/.codexcommander/config.json`. На Windows путь по умолчанию —
`%USERPROFILE%\.codexcommander\config.json`.

## Способы редактировать конфигурацию

Выберите канал редактирования под задачу:

- **Dashboard:** используйте web UI для пошаговой настройки провайдеров, моделей, агентов,
  доступа и хранилища.
- **CLI:** `ccx init` создаёт исходный файл, а команды вроде `ccx provider`, `ccx models`,
  `ccx combo`, `ccx agent` и `ccx config` обновляют или показывают принадлежащие им настройки.
- **File:** редактируйте `config.json` напрямую для полей, у которых нет отдельной UI- или
  CLI-команды. Файл должен оставаться корректным JSON.

Dashboard, management API и mutating-команды CLI записывают в один и тот же файл. Предпочитайте
эти каналы либо останавливайте прокси перед ручным редактированием. Запущенный процесс держит
конфигурацию в памяти, поэтому более позднее сохранение «наживую» может перезаписать несвязанные
ручные изменения своим снимком. Живые сохранения умеют merge'ить внешние правки полей
`claudeCode` и listener binding там, где для этих путей есть явная защита конфликтов, но эта
защита покрывает не все поддеревья.

Если файл не удаётся распарсить, CodexCommander сохраняет его резервную копию как
`config.json.invalid-<timestamp>`, пишет предупреждение в консоль и стартует с настройками по
умолчанию. Если файла нет, используется тот же свежий дефолт: один forward-провайдер `openai`.

## Приоритет и значения по умолчанию

Корректные значения из `config.json` перекрывают встроенные дефолты. Для отсутствующих
необязательных полей применяются значения по умолчанию, описанные на страницах соответствующих
доменов. `CODEXCOMMANDER_HOME` имеет приоритет над каталогом конфигурации по умолчанию. Поля, которые
принимают ссылку на окружение, например `apiKey: "${PROVIDER_API_KEY}"`, разрешают эту переменную
в момент запроса. Для outbound-proxying уже заданные `HTTP_PROXY` или `HTTPS_PROXY` имеют
приоритет над верхнеуровневым полем `proxy`.

Для routing действует собственный упорядоченный набор правил разрешения; см.
[Routing](/reference/configuration/routing/).

## Домены конфигурации

- [Providers](/reference/configuration/providers/) — записи провайдеров, аутентификация,
  endpoint'ы, каталоги, allowlist'ы, лимиты контекста, квоты и provider-specific параметры.
- [Routing](/reference/configuration/routing/) — `defaultProvider`, порядок разрешения моделей,
  combo, alias и значения combo effort по умолчанию.
- [Agents](/reference/configuration/agents/) — multi-agent mode, guidance при делегировании,
  fallback-модели, синхронизация нативных default'ов и effort cap'ы.
- [Server and runtime](/reference/configuration/server/) — listener и удалённый доступ,
  admission key, таймауты, storage, sidecar'ы, startup behavior и shadow call'ы.

## Не храните секреты в файле

Для API-ключей предпочитайте ссылки `${ENV_VAR}`. Буквальные значения `apiKey`,
`apiKeyPool[].key` и `apiKeys[].key` — это секреты; не коммитьте их, не вставляйте в логи и не
делитесь ими. OAuth-токены и forward-provider токены хранятся в отдельных credential store, а не
в `config.json`. Идентификаторы аккаунтов и email тоже должны оставаться приватными; где
возможно, используйте публичные alias для селекторов.

:::note[Atomic writes]
CodexCommander записывает управляемые файлы `config.toml` и `codexcommander-catalog.json` через временный
файл с последующим rename (`atomicWriteFile`).
Это предотвращает частично записанные файлы, когда одновременно срабатывают несколько writer'ов,
например `ccx stop` и shutdown handler самого прокси, оба восстанавливающие Codex.
:::

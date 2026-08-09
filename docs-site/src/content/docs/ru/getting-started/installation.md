---
title: Установка
description: Установите прокси CodexCommander (ccx) и необходимые компоненты и убедитесь, что он запускается.
---

В пакетной или локально связанной сборке CodexCommander предоставляет два эквивалентных имени команды: `ccx` и `codexcommander`. Обе запускают один и
тот же небольшой локальный HTTP-сервер (построенный на Bun). Запросы к моделям идут к провайдеру,
выбранному маршрутизацией; опциональные сайдкары для vision и веб-поиска также могут использовать
ваш вход в ChatGPT, когда они нужны маршрутизируемой модели.

## Предварительные требования

| Требование | Зачем |
| --- | --- |
| **[Bun](https://bun.sh)** | Исходный рантайм и скрипты репозитория выполняются непосредственно через Bun. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App или SDK) | Клиент, перед которым работает CodexCommander. CodexCommander записывает данные в `$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`). |
| Аккаунт провайдера или API-ключ | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI-совместимая конечная точка или ваш вход в ChatGPT. |

## Запуск исходного checkout

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start
```

Пакет в реестре сейчас не опубликован. В этом checkout заменяйте `ccx <args>` на
`bun run src/cli/index.ts <args>`. В другом терминале проверьте рантайм:

```bash
bun run src/cli/index.ts --version
```

## Режим разработки

При изменении UI запускайте прокси и панель управления отдельно:

```bash
bun run dev:proxy   # запускает API прокси в режиме разработки (src/cli/index.ts start)
bun run dev:gui     # запускает dev-сервер панели управления (в другом терминале)
```

`bun run dev` — псевдоним для `bun run dev:proxy`. API прокси предоставляет `/healthz`,
`/v1/responses` и `/api/*`; `GET /` отдаёт упакованную панель управления только после того, как
`bun run build:gui` создаст `gui/dist`. Пока вы работаете над панелью управления, запускайте
фронтенд отдельно командой `bun run dev:gui`. Компаньон macOS собирается из того же checkout командами `bun run test:macos && bun run build:macos`; исходная сборка находится в `dist/macos/CodexCommander.app`.

## Что создаётся

Состояние CodexCommander хранится в `$CODEXCOMMANDER_HOME` (по умолчанию `~/.codexcommander`). Файлы интеграции
с Codex находятся в `$CODEX_HOME` (по умолчанию `~/.codex`).

| Путь | Назначение |
| --- | --- |
| `$CODEXCOMMANDER_HOME/config.json` | Ваши провайдеры, провайдер по умолчанию, порт и параметры. |
| `$CODEXCOMMANDER_HOME/codexcommander.pid` | PID запущенного прокси (защита от повторного запуска). |
| `$CODEXCOMMANDER_HOME/runtime-port.json` | Текущие PID, имя хоста и порт, включая автоматически выбранный запасной порт. |
| `$CODEXCOMMANDER_HOME/auth.json` | Сохранённые учётные данные OAuth (после `ccx login`). |
| `$CODEXCOMMANDER_HOME/catalog-backup-<catalog-id>.json` | Резервные копии каталога моделей Codex, создаваемые перед тем, как CodexCommander его изменит. |
| `$CODEX_HOME/config.toml` | На loopback-адресе CodexCommander добавляет корневой `openai_base_url`, отмеченный собственным маркером; при привязке не к loopback используются `model_provider = "codexcommander"` и `[model_providers.codexcommander]`, чтобы Codex мог отправлять заголовок API-аутентификации. |
| `$CODEX_HOME/codexcommander.config.toml` | Резервный/справочный профиль, записываемый рядом с основной конфигурацией Codex. |
| `$CODEX_HOME/codexcommander-catalog.json` | Синхронизированный каталог нативных и маршрутизируемых моделей, используемый Codex. |

:::note
CodexCommander никогда не удаляет вашу конфигурацию Codex. Каждое внедрение обратимо — `ccx stop`,
`ccx restore` или `ccx eject` убирают ровно те строки, которые добавил CodexCommander, и восстанавливают
нативный Codex.
:::

## Далее

Переходите к разделу [Быстрый старт](/ru/getting-started/quickstart/), чтобы настроить
первого провайдера, или прочитайте [Как это работает](/ru/getting-started/how-it-works/),
чтобы разобраться в архитектуре.

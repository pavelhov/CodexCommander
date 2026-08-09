---
title: Жизненный цикл CLI
description: Настройка, запуск, остановка, служба, диагностика и sync-команды.
---

Эти команды устанавливают, запускают, проверяют и ремонтируют локальный прокси
CodexCommander и его интеграцию с Codex.

## Настройка

### `ccx init` · `ccx setup`

Интерактивный мастер настройки (`setup` — alias команды `init`). Он спрашивает провайдера
(preset или custom), API-key (буквально или `${ENV}`), модель по умолчанию и порт прокси,
сохраняет `~/.codexcommander/config.json`; при желании внедряет прокси в
`$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`) и при необходимости
устанавливает shim автозапуска Codex.

## Жизненный цикл прокси

### `ccx start [--port <port>]`

Запустить proxy server (предпочтительный порт `10100`). Если этот порт занят, CodexCommander выбирает и
записывает другой свободный порт. При запуске пишется состояние PID/runtime-port, а попытка
поднять второй живой экземпляр отвергается. На старте прокси синхронизирует модели каждого
провайдера в каталог Codex. При shutdown он восстанавливает native Codex — если только прокси не
был запущен как managed service (`CCX_SERVICE=1`).

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

Остановить работающий прокси (по PID), удалить PID-file и восстановить native Codex. Если
установлена managed background service, `ccx stop` сначала останавливает и её, чтобы она не
перезапустила прокси обратно. То же действие доступно из кнопки **Stop** в веб-дашборде
(`POST /api/stop`).

### `ccx restart`

Выполнить `stop`, затем `ensure`: остановить прокси/службу, восстановить native Codex, поднять
прокси в фоне и синхронизировать живой порт обратно в Codex.

### `ccx ensure`

Идемпотентно убедиться, что фоновый прокси запущен, а затем синхронизировать его живой каталог
моделей. Если `codexAutoStart` равен `false`, команда сообщает, что автозапуск отключён, и ничего
не делает.

### `ccx restore [back]` · `ccx eject [back]`

Восстановить native Codex **без** остановки прокси — удалить внедрённые строки конфигурации и
маршрутизируемые записи каталога, чтобы обычный `codex` снова работал нативно. `eject` — alias
команды `restore`.

Передайте `back`, чтобы любая из этих форм снова направила обычный `codex` на уже запущенный
прокси, не меняя жизненный цикл самого прокси:

```bash
ccx restore back
ccx eject back
```

### `ccx uninstall` · `ccx remove`

Остановить службу и прокси, удалить службу и Codex shim, восстановить native Codex, а затем
удалить локальную конфигурацию CodexCommander только если все шаги восстановления завершились успешно.
`remove` — alias команды `uninstall`. Очистка конфигурации требует ownership metadata, созданных
канонической метадатой владения; каталоги без владельца или shared-directory остаются на месте.

## Status и health

### `ccx status [--json]`

Печатает read-only диагностическую сводку: PID прокси, достижимость `/healthz`, URL дашборда,
путь к конфигу, провайдера по умолчанию, настройку автозапуска Codex, состояние службы, состояние
shim'а и redacted effective Codex home. Только явная и высокоуверенная сигнатура mismatch
runtime-home Windows Orca даёт actionable-warning о несоответствии App-home; `CODEX_HOME`
автоматически при этом не меняется.

В текстовом выводе после сводки OAuth-logins также присутствует блок **OAuth health**:
`OAuth health: ok`, если все известные аккаунты здоровы, либо `OAuth health: warning` с одной
redacted-строкой на каждый нездоровый аккаунт (провайдер, замаскированный id аккаунта, статус
вроде reauthentication required, rate/quota limited или refresh conflict) плюс необязательная
подсказка `Action:`. Идентификаторы маскируются; токены и email никогда не печатаются. В
контракт `--json` этот health-блок пока не входит.

```bash
ccx status
ccx status --json
```

Сокращённая форма JSON:

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

Реальный объект также включает `listen` (порт, hostname, источник runtime/config), диагностику
загрузки конфига и диагностику bundled-plugin'а Codex. JSON-schema только расширяемая: новые
версии могут добавлять поля, но существующие должны оставаться стабильными. Она намеренно не
включает API-key'и, OAuth-token'ы, заголовки авторизации, содержимое запросов, email и
идентификаторы аккаунтов.

### `ccx health [--json]`

Identity-check живого прокси. Текстовый вывод сообщает PID/порт; `--json` отдаёт
`{ok, pid, port}`. Команда завершается кодом 0 только когда прокси здоров, и 1 во всех остальных
случаях, поэтому подходит для service probe.

### `ccx ready [--json] [--wait [--timeout <seconds>]]`

Проверяет готовность после синхронизации через не требующий аутентификации `GET /readyz`. При
готовности возвращается `200`; для `pending` и терминального `failed` возвращается `503` с
`Retry-After: 1`. Санитизированные поля HTTP-ответа: `{service, version, uptime, pid, port, status}`.
`/healthz` — отдельная проверка liveness, а не готовности. По умолчанию команда выполняет одну пробу.
`--wait` опрашивает до готовности или
тайм-аута, но при терминальном `failed` завершается немедленно. Тайм-аут по умолчанию — 45 секунд;
`--timeout <seconds>` требует `--wait` и принимает целые положительные значения 1–300 секунд. CLI JSON выдаёт
`{ready, status, pid, port}`, где `status` — `ready`, `pending`, `failed` или
`unreachable`. Коды завершения: 0 — готово; 1 — не готово, pending, failed, тайм-аут или
недоступность; 64 — недопустимые аргументы.

### `ccx doctor`

Запускает read-only диагностику среды и связности: пути состояний и тип файловой системы,
двойные установки WSL, proxy environment/config, достижимость ChatGPT, предупреждения о plugin'е
и project-config Codex. Раздел, касающийся app-home Codex, тоже обнаруживает узкий mismatch
runtime-home Windows Orca и при необходимости показывает ручные шаги удаления, настройки окружения
и повторной установки. Пути в этом выводе маскируют имя пользователя ОС. Doctor печатает подсказки
по ремонту, но ничего не меняет.

Раздел **OAuth reliability** показывает, можно ли записывать credential storage, удаётся ли
создавать refresh single-flight/lock file'ы в `CODEXCOMMANDER_HOME`, есть ли нездоровые OAuth- или
Codex-pool-аккаунты (с masked-id) с подсказкой `Action:`, а также статическое OK-подтверждение,
что путь Codex forward не подделывает metadata официального клиента. Doctor никогда не мутирует
credential'ы и не выполняет repair.

## Синхронизация каталога

### `ccx sync [--restart-codex]`

Получить живой список моделей от каждого настроенного провайдера и заново внедрить объединённый
каталог в Codex. Запускайте после добавления провайдера или когда нужно обновить доступные
модели.

Если всё ещё работают долгоживущие процессы Codex `app-server`, `ccx sync` предупредит, что они
могут продолжать отдавать старый in-memory список моделей, хотя файлы
`codexcommander-catalog.json` / `models_cache.json` уже обновлены. Передайте `--restart-codex`, чтобы
послать `SIGTERM` только подходящим процессам `codex … app-server` и `codex-code-mode-host`,
принадлежащим текущему пользователю (активные turn'ы при этом могут оборваться). Широкий
`pkill -f codex` намеренно не используется.

### `ccx sync-cache [--restart-codex]`

Инвалидировать локальный кэш model picker'а Codex, чтобы он пересобрался из активного каталога
CodexCommander. Предупреждение о stale-`app-server` и optional `--restart-codex` работают так же, как
и у `ccx sync`.

## Фоновая служба

### `ccx service [install|repair|start|stop|status|uninstall|remove]`

Запустить CodexCommander как login-managed background service (macOS **launchd**, Linux **systemd user
unit**, Windows **Task Scheduler**), которая автоматически стартует при логине и сама
перезапускается при crash. Запуски службы выставляют `CCX_SERVICE=1`, чтобы restart не дёргал
конфиг Codex.

| Подкоманда | Действие |
| --- | --- |
| none | Создать/обновить и запустить службу. |
| `install` | Создать и запустить службу. |
| `repair` | Обновить установленную службу на месте и перезапустить её без повторной регистрации. |
| `start` | Запустить уже установленную службу. |
| `stop` | Остановить службу и восстановить native Codex. |
| `status` | Показать диагностику службы и прокси, а также пути к логам. |
| `uninstall` | Удалить службу и восстановить native Codex. |
| `remove` | Alias команды `uninstall`. |

```bash
ccx service
ccx service install
ccx service repair
ccx service status
ccx service uninstall
```

На Windows `ccx service status` отдельно показывает регистрацию в Task Scheduler и
identity-проверенную достижимость прокси CodexCommander. Он не печатает локализованную таблицу
`schtasks`, чтобы сводка оставалась читаемой на любых code page Windows.

На Windows создание записи в Task Scheduler требует elevation. Когда распознан локализованный
текст access-denied, остаётся прежний путь guidance. Если текст неразборчив, fallback использует
владение command-shape `/create /tn codexcommander-proxy /xml <non-empty-path> /f`, status 1 и
подтверждённый non-elevated token; после этого действие Startup Safety в дашборде может само
запросить UAC. Если fallback не смог определить состояние token'а, он оставляет исходную
scheduler-error. Чужие задачи и чужие операции никогда не получают automatic-elevation marker.
Либо подтвердите UAC через дашборд, либо заново выполните `ccx service install` в elevated
окне PowerShell.

### `ccx codex-shim <install|status|uninstall|remove>`

Обернуть script-based launcher `codex` на `PATH` лёгким автозапусковым скриптом. Настоящие
target'ы `codex.exe` не трогаются, чтобы не ломать точные вызовы исполняемого файла.

Если завершённое внешнее обновление Codex перезаписало установленный shim, следующая обычная
команда `ccx` сохранит новый стабильный launcher и восстановит shim перед выполнением запроса.
Launcher, который всё ещё меняется, не трогается, а попытка откладывается до следующего раза.
Сбои repair'а приводят только к warning и не ломают запрошенную команду; ручной запасной путь —
`ccx codex-shim install`. Чтобы отключить автоматику, задайте `codexShimAutoRestore: false` или
установите `CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE=0`.

| Подкоманда | Действие |
| --- | --- |
| `install` | Установить shim (или починить, если он устарел). |
| `uninstall` | Удалить shim и восстановить исходный бинарник Codex. |
| `remove` | Alias команды `uninstall`. |
| `status` | Показать состояние shim'а (installed, stale или missing). |

```bash
ccx codex-shim install
ccx codex-shim status
ccx codex-shim uninstall
```

:::tip[Service vs Shim]
Используйте `ccx service` для всегда работающего фонового прокси (рекомендуется). Используйте
`ccx codex-shim` для лёгкого on-demand запуска без демона — в этом случае прокси стартует только
когда запускается `codex`.
:::

### `ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Установить и управлять Windows tray icon со статусом. Иконка стартует при логине в Windows и даёт
one-click управление прокси. `start` и `stop` управляют только иконкой; самим прокси нужно
управлять из её меню. `--no-start` применяется к `install` и устанавливает tray, не запуская её
немедленно.

## Дашборд

### `ccx gui`

Открыть [веб-дашборд](/guides/web-dashboard/) по адресу `http://localhost:<port>`, автоматически
запустив прокси, если он ещё не работает.

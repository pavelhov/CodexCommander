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
сохраняет `~/.codexcommander/config.json`; при желании направляет Codex через уже запущенный прокси,
подтверждённый защищённой runtime-записью текущего home, и устанавливает shim автозапуска Codex.
Если такой прокси не подтверждён, Codex остаётся native, а последующий `ccx start` выполняет явный
запуск и переключение маршрута. Сам `init` не запускает прокси и не записывает маршрут к
неподтверждённому listener.

## Жизненный цикл прокси

### `ccx start [--port <port>]`

Запустить proxy server (предпочтительный порт `10100`). Если этот порт занят, CodexCommander выбирает и
записывает другой свободный порт. При запуске пишется состояние PID/runtime-port, а попытка
поднять второй живой экземпляр отвергается. Явный запуск (`ccx start`, Start в трее или
явные `ccx service start`, `install`, `repair`) включает интеграцию Codex,
синхронизирует модели каждого провайдера в каталог Codex и направляет Codex через работающий
прокси. Автоматический `ensure` сохраняет намеренно отключённую интеграцию. При shutdown прокси
восстанавливает native Codex — если только он не был запущен как managed service (`CCX_SERVICE=1`).

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

Сначала сохранить выбор native/OFF и восстановить нативную маршрутизацию Codex, затем остановить
работающий прокси (по PID) и удалить PID-file. Если нативный маршрут нельзя проверить, прокси и
служба продолжают работать. Если установлена managed background service, `ccx stop` останавливает
её после восстановления, чтобы она не перезапустила прокси. Кнопка **Stop** в веб-дашборде вызывает
raw `POST /api/stop`: он останавливает прокси без supervisor, но отказывает, если прокси принадлежит
установленному supervisor. В таком случае используйте Stop из CLI или трея, который сначала остановит
manager под той же lifecycle authority.

### `ccx restart`

Выполнить тот же безопасный цикл stop→start, что и **Restart Proxy…** в строке меню macOS: сначала
восстановить и проверить native Codex, затем завершить старый прокси/службу, а на явном этапе Start
запустить новый прокси и снова направить через него Codex. При ошибке Codex остаётся на нативном
маршруте.

### `ccx ensure`

Идемпотентно убедиться, что фоновый прокси запущен, а затем синхронизировать его живой каталог
моделей. Если `codexAutoStart` равен `false`, команда сообщает, что автозапуск отключён, и ничего
не делает.

### `ccx restore [back]` · `ccx eject [back]`

Восстановить native Codex **без** остановки прокси. Нативный escape удаляет только маршрут,
принадлежащий CodexCommander и отмеченный его маркером, а также принадлежащий ему указатель каталога
из `$CODEX_HOME/config.toml`, сохраняя все посторонние настройки. Он не читает и не изменяет каталог,
задачи, историю или аутентификацию. Для него не нужны ни команда `repair`, ни база данных координатора.
`eject` — alias команды `restore`. Сгенерированные каталоги и кэши могут остаться на диске, но native
Codex больше на них не ссылается. Эта команда относится только к Codex: она не меняет интеграцию
Grok или других клиентов. Для удаления всех управляемых маршрутов нативных клиентов используйте
`ccx stop` или `ccx uninstall`.

Передайте `back`, чтобы любая из этих форм снова направила обычный `codex` на уже запущенный
прокси, не меняя жизненный цикл самого прокси. Route Back — явный переход ON. Recovery journal —
это защищённая контрольная точка точной записи config/profile, сделанной CodexCommander, а не
отдельная настройка маршрута. Если желаемая интеграция уже ON, подтверждённый current-home работающий
прокси владеет стабильным journal, а записанный profile postimage точно совпадает с текущим profile,
Route Back принимает либо точный записанный config postimage, либо стабильный точный marker-owned
managed descendant, чей управляемый маршрут удаляется до независимо native-safe config. Поэтому
посторонние изменения настроек Codex после sync допускаются. Route Back сохраняет active journal и
идемпотентно завершается как no-op. Из native/OFF существующая coordination удаляет только доказанно
stale journal. Неверный владелец или profile, недостающая проверка, изменённая/custom/неоднозначная
маршрутизация, временная write surface или гонка наблюдения оставляют Codex в native/OFF. Не удаляйте
и не редактируйте journal вручную:

```bash
ccx restore back
ccx eject back
```

После успешного Restore Native или Route Back полностью завершите ChatGPT, снова откройте его и
начните новую задачу, чтобы работающий хост Codex загрузил сохранённый маршрут.

### `ccx uninstall` · `ccx remove`

В рамках одной lifecycle-транзакции остановить службу и прокси, удалить службу и Codex shim,
восстановить и повторно проверить native Codex, а затем удалить локальные артефакты CodexCommander
только если все шаги завершились успешно. `remove` — alias команды `uninstall`. Очистка требует
канонических ownership metadata; каталоги без владельца и shared-directory остаются на месте.
Небольшая пара owner/manifest metadata сохраняется в корне конфигурации, чтобы параллельный Start
не мог создать второе пространство имён lifecycle-lock.

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

:::note[Однократный перезапуск после обновления]
У уже работающего прокси от старой сборки в защищённой runtime-записи может отсутствовать `attestationSecret`. Один раз перезапустите этот прокси перед CLI-командами управления или запуском Claude/OpenCode с credential'ами. До этого чувствительные запросы fail closed: token и request body никогда не отправляются listener'у, найденному только через public health или настроенный port.
:::

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

Обычный `ccx sync` не прерывает работу. Новый task или fork в том же app-server не заставляет его перечитать каталог. Используйте **Apply agent catalog** в дашборде, `ccx sync --restart-codex` или закройте и снова откройте Codex Desktop.

### `ccx sync-cache [--restart-codex]`

Инвалидировать локальный кэш model picker'а Codex, чтобы он пересобрался из активного каталога
CodexCommander. Предупреждение о stale-`app-server` и optional `--restart-codex` работают так же, как
и у `ccx sync`.

## Фоновая служба

### `ccx service [install|repair|start|stop|status|uninstall|remove]`

Запустить CodexCommander как login-managed background service (macOS **launchd**, Linux **systemd user
unit**, Windows **Task Scheduler**), которая автоматически стартует при логине и сама
перезапускается при crash. Запуски службы выставляют `CCX_SERVICE=1`, чтобы автоматический restart менеджера не дёргал
конфиг Codex. Явное создание службы, а также `install`, `repair` и `start` включают
интеграцию Codex и направляют Codex через прокси.

| Подкоманда | Действие |
| --- | --- |
| none | Создать/обновить и запустить службу. |
| `install` | Создать и запустить службу. |
| `repair` | Обновить установленную службу на месте и перезапустить её без повторной регистрации. |
| `start` | Запустить уже установленную службу. |
| `stop` | Восстановить и проверить native Codex, затем остановить службу. Если проверка не удалась, служба и прокси продолжают работать. |
| `status` | Показать диагностику службы и прокси, а также пути к логам. |
| `uninstall` | Восстановить и проверить native Codex, затем остановить и удалить службу. |
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
запустив прокси, если он ещё не работает. Краткоживущий одноразовый browser launch-ticket открывает изменения, включая подтверждённый **Apply agent catalog**. Ticket передаётся только во fragment URL и удаляется во время обмена. Подтверждённая сессия хранится в памяти серверного процесса до восьми часов; браузер копирует в `sessionStorage` только её token, CSRF-token, origin и абсолютное время истечения. Поэтому перезагрузка работает, пока серверная сессия действительна. Сессия не продлевается. Истечение срока, перезапуск прокси или отклоняющий `401` очищает browser-запись; откройте страницу снова через `ccx gui` или приложение строки меню macOS. Ни постоянный admin-token, ни launch-ticket не попадают в browser storage; для аутентификации не используется `localStorage`. Скрипт того же origin может читать session-запись, поэтому это удобство не является изоляцией пользователей ОС. Браузер может скопировать запись в дублированную или созданную opener'ом вкладку либо восстановить её вместе с восстановленной вкладкой. Каждая копия остаётся привязанной к точным origin и CSRF-token и пригодна только до фиксированного серверного срока, перезапуска прокси или отклоняющего `401`. При ручном открытии loopback-страницы API-сессия не выдаётся, и постоянный admin-token никогда не запрашивается и не отправляется.

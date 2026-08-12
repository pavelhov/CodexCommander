---
title: CLI 수명 주기
description: 설정, 시작, 중지, 서비스, 진단, 동기화 명령입니다.
---

이 명령들은 로컬 CodexCommander 프록시와 Codex 연동을 설치, 실행, 점검, 복구합니다.

## 설정

### `ccx init` · `ccx setup`

대화형 설정 마법사입니다 (`setup`은 `init`의 별칭입니다). 공급자(프리셋 또는 사용자 지정),
API 키(리터럴 또는 `${ENV}`), 기본 모델, 프록시 포트를 묻고 `~/.codexcommander/config.json`에 저장합니다.
원하면 보호된 current-home runtime record로 확인된 실행 중 프록시를 통해 Codex를 라우팅하고,
Codex 자동 시작 shim도 설치합니다. 확인된 프록시가 없으면 Codex는 네이티브 상태로 남고 이후
`ccx start`가 명시적인 시작과 라우팅을 수행합니다. `init` 자체는 프록시를 시작하거나 확인되지 않은
listener로 향하는 route를 쓰지 않습니다.

## 프록시 수명 주기

### `ccx start [--port <port>]`

프록시 서버를 시작합니다(권장 포트는 `10100`). 해당 포트가 이미 사용 중이면 CodexCommander가 다른
사용 가능한 포트를 골라 기록합니다. PID와 런타임 포트 상태를 기록하고, 두 번째 활성 인스턴스는 시작하지
않습니다. 명시적으로 시작하면 Codex 연동을 활성화하고 각 공급자의 모델을 Codex 카탈로그로 동기화한 뒤,
Codex가 실행 중인 프록시를 통하도록 라우팅합니다. 여기에는 `ccx start`, 트레이의 Start, 명시적인
`ccx service start`, `install`, `repair`가 포함됩니다. `ccx ensure`는 의도적으로 비활성화된 연동 상태를
유지합니다. 일반 독립 실행 종료 시에는 네이티브 Codex를 복원합니다. 단, 관리형 서비스로 실행한
경우(`CCX_SERVICE=1`)는 예외입니다.

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

먼저 네이티브 Codex 라우팅을 복원한 다음 실행 중인 프록시를 PID 기준으로 중지하고 PID 파일을
삭제합니다. 네이티브 경로를 검증할 수 없으면 프록시와 서비스는 계속 실행됩니다. 관리형 백그라운드 서비스가
설치되어 있으면 `ccx stop`이 네이티브 복원 후 서비스를 중지하므로 프록시가 다시 올라올 수 없습니다.
웹 대시보드의 **Stop** 버튼은 raw `POST /api/stop`을 호출합니다. supervisor가 없는 프록시는
중지하지만 설치된 supervisor가 소유한 경우에는 거부됩니다. 이때는 같은 lifecycle authority 아래에서
manager를 먼저 중지할 수 있는 CLI 또는 트레이 Stop을 사용하십시오.

### `ccx restart`

macOS 트레이의 **Restart Proxy…**와 동일한 안전한 중지→시작 트랜잭션을 실행합니다. 기존 프록시/서비스를
종료하기 전에 네이티브 Codex를 복원하고 검증한 다음, 명시적 Start 단계에서 새 프록시를 시작하고 Codex가
다시 해당 프록시를 통하도록 라우팅합니다. 재시작에 실패하면 Codex는 네이티브 상태로 유지됩니다.

### `ccx ensure`

백그라운드 프록시가 실행 중인지 멱등적으로 보장한 다음, 살아 있는 모델 카탈로그를 동기화합니다.
`codexAutoStart`가 `false`이면 자동 시작이 비활성화되었다고 출력하고 아무것도 하지 않습니다.

### `ccx restore [back]` · `ccx eject [back]`

프록시를 중지하지 않고 네이티브 Codex를 **복원**합니다. 네이티브 전환은
<code>$CODEX_HOME/config.toml</code>에서 CodexCommander의 마커가 소유한 정확한 경로와 소유 대상인
카탈로그 포인터만 제거하고 관련 없는 모든 설정을 보존합니다. 카탈로그, 작업, 기록 또는 인증을 읽거나
다시 쓰지 않습니다. 복구 명령이나 코디네이터 데이터베이스도 필요하지 않습니다. `eject`는 `restore`의
별칭입니다. 생성된 catalog와 cache는 디스크에 남을 수 있지만 네이티브 Codex는 더 이상 참조하지 않습니다.
이 명령은 Codex 전용이며 Grok 또는 다른 클라이언트 연동은 변경하지 않습니다. 관리되는 모든 네이티브
클라이언트 경로를 해제하려면 `ccx stop` 또는 `ccx uninstall`을 사용하세요.

둘 중 어느 표기든 `back`을 붙이면 이미 실행 중인 프록시를 가리키도록 일반 `codex`를 다시
연결하되, 프록시 수명 주기는 바꾸지 않습니다. Route Back은 명시적인 ON 전환입니다. recovery journal이
있다면 기존 coordination이 stale로 증명한 journal만 폐기하며, 증명하지 못하면 Codex를 native/OFF로
유지합니다.

```bash
ccx restore back
ccx eject back
```

### `ccx uninstall` · `ccx remove`

하나의 수명 주기 트랜잭션으로 서비스와 프록시를 중지하고, 서비스와 Codex shim을 제거한 뒤,
네이티브 Codex를 복원하고 다시 검증합니다. 모든 단계가 성공했을 때만 CodexCommander 로컬
아티팩트를 제거합니다. `remove`는 `uninstall`의 별칭입니다. 설정 정리에는 정식 소유권
메타데이터가 필요하며, 소유되지 않았거나 공유된 디렉터리는 그대로 둡니다. 동시에 실행되는
Start가 두 번째 수명 주기 잠금 네임스페이스를 만들 수 없도록 작은 owner/manifest 메타데이터
쌍은 설정 루트에 유지됩니다.

## 상태 및 헬스

### `ccx status [--json]`

읽기 전용 진단 요약을 출력합니다. 프록시 PID, `/healthz` 도달 가능 여부, 대시보드 URL,
설정 경로, 기본 공급자, Codex 자동 시작 설정, 서비스 상태, shim 상태, 그리고 마스킹된
실제로 적용되는 Codex 홈이 포함됩니다. 명시적이고 높은 신뢰도의 Windows Orca 런타임 홈 시그니처만
실행 가능한 App 홈 불일치 경고를 추가하며, `CODEX_HOME`을 자동으로 바꾸지는 않습니다.

일반 출력에는 OAuth 로그인 요약 뒤에 **OAuth health** 블록도 표시합니다. 모든 알려진 계정이
정상이면 `OAuth health: ok`를, 그렇지 않으면 `OAuth health: warning`과 함께 건강하지 않은
각 계정마다 한 줄씩(공급자, 마스킹된 계정 ID, 재인증 필요, 속도 또는 할당량 제한, 갱신
충돌 같은 상태), 그리고 선택적인 `Action:` 힌트를 보여줍니다. 계정 ID는 마스킹되며 토큰과
이메일은 절대 출력하지 않습니다. `--json` 계약에는 이 헬스 블록이 아직 포함되지 않습니다.

```bash
ccx status
ccx status --json
```

축약 예시 형태는 다음과 같습니다.

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

실제 객체에는 `listen`(포트, 호스트명, 런타임/설정 소스), 설정 로드 진단, 번들 Codex 플러그인
진단도 포함됩니다. JSON 스키마는 추가만 허용합니다. 앞으로 버전에서 필드가 추가될 수는 있지만,
기존 필드는 안정적으로 유지되어야 합니다. 이 스키마는 API 키, OAuth 토큰, Authorization 헤더,
요청 내용, 이메일, 계정 식별자를 의도적으로 제외합니다.

### `ccx health [--json]`

실행 중인 프록시의 신원 확인을 수행합니다. 일반 출력은 PID/포트를 보고하고, `--json`은
`{ok, pid, port}`를 내보냅니다. 이 명령은 정상일 때만 종료 코드 0을, 그렇지 않으면 1을 반환하므로
서비스 프로브에 적합합니다.

### `ccx ready [--json] [--wait [--timeout <seconds>]]`

인증이 필요 없는 `GET /readyz` 엔드포인트로 동기화 후 준비 상태를 확인합니다. 준비되면 `200`,
`pending` 또는 종단 상태인 `failed`이면 `Retry-After: 1`과 함께 `503`을 반환합니다. HTTP의 정제된
식별 필드는 `{service, version, uptime, pid, port, status}`입니다. `/healthz`는 준비 상태가 아닌 별도의
liveness 확인입니다. 기본값은 한 번의
probe이며, `--wait`는 준비 또는 timeout까지 polling하지만 종단 `failed`를 확인하면 즉시 종료합니다.
기본 timeout은 45초이며, `--timeout <seconds>`는 `--wait`와 함께 써야 하고 양의 정수인 1~300초 범위를 받습니다. CLI JSON은
`{ready, status, pid, port}`를 출력하며 `status`는 `ready`, `pending`, `failed`,
`unreachable` 중 하나입니다. 종료 코드는 ready가 0, not-ready/pending/failed/timeout/unreachable이
1, 잘못된 인수가 64입니다.

### `ccx doctor`

읽기 전용 환경 및 연결 진단을 실행합니다. 상태 경로와 파일시스템 유형, WSL 이중 설치, 프록시
환경/설정, ChatGPT 도달 가능성, Codex 플러그인 및 프로젝트 설정 경고가 포함됩니다. Codex 앱 홈
대상 지정 섹션은 좁은 범위의 Windows Orca 런타임 홈 불일치도 감지하고, 해당할 때 수동 제거,
환경 설정, 재설치 단계를 표시합니다. 이 진단에 표시되는 경로는 OS 사용자 이름을 마스킹합니다.
doctor는 복구 힌트를 보여 주지만 직접 적용하지는 않습니다.

**OAuth 안정성** 섹션은 자격 증명 저장소에 쓰기 가능한지, `CODEXCOMMANDER_HOME` 아래에 refresh
single-flight/lock 파일을 만들 수 있는지, 건강하지 않은 OAuth 또는 Codex pool 계정(마스킹된 ID)과
복구용 `Action:`, 그리고 Codex 전달 경로가 공식 클라이언트 메타데이터를 꾸며 내지 않는다는
정적 OK를 보고합니다. doctor는 자격 증명을 변경하거나 복구를 적용하지 않습니다.

:::note[업그레이드 후 한 번 재시작]
이전 빌드에서 계속 실행 중인 프록시는 보호된 런타임 레코드에 `attestationSecret`이 없을 수 있습니다. CLI 관리 명령이나 자격 증명을 전달하는 Claude/OpenCode 클라이언트를 사용하기 전에 해당 프록시를 한 번 재시작하세요. 그전에는 민감한 요청이 fail closed되며, 공개 health 정보나 설정 포트로만 찾은 listener에 token 또는 request body를 보내는 fallback은 없습니다.
:::

## 카탈로그 동기화

### `ccx sync [--restart-codex]`

설정된 모든 공급자에서 라이브 모델 목록을 가져와 병합된 카탈로그를 Codex에 다시 주입합니다.
공급자를 추가한 뒤나 사용 가능한 모델을 새로 고칠 때 실행합니다.

오래 실행 중인 Codex `app-server` 프로세스가 아직 살아 있으면, `codexcommander-catalog.json` /
`models_cache.json`가 업데이트되었더라도 이전 인메모리 모델 목록을 계속 서비스할 수 있다고 경고합니다.
`--restart-codex`를 붙이면 현재 사용자가 소유한 `codex … app-server`와 `codex-code-mode-host`
프로세스 중 일치하는 것에만 `SIGTERM`을 보냅니다(활성 작업이 중단될 수 있습니다). 광범위한
`pkill -f codex` 매칭은 의도적으로 피합니다.

일반 `ccx sync`는 중단하지 않습니다. 같은 app-server에서 새 task를 시작하거나 fork해도 카탈로그를 다시 읽지 않습니다. 대시보드의 **Apply agent catalog**, `ccx sync --restart-codex`, 또는 Codex Desktop을 종료 후 다시 여세요.

### `ccx sync-cache [--restart-codex]`

Codex의 로컬 모델 선택기 캐시를 무효화하여, 활성 CodexCommander 카탈로그에서 다시 빌드되게 합니다.
`ccx sync`와 같은 오래된 `app-server` 경고와 선택적 `--restart-codex` 동작이 적용됩니다.

## 백그라운드 서비스

### `ccx service [install|repair|start|stop|status|uninstall|remove]`

로그인 관리형 백그라운드 서비스로 CodexCommander를 실행합니다(macOS **launchd**, Linux **systemd** 사용자
유닛, Windows **Task Scheduler**). 로그인 시 자동 시작하고 충돌 시 자동 재시작합니다. 서비스 실행은
`CCX_SERVICE=1`을 설정하므로 서비스 관리자의 자동 재시작은 Codex 설정을 반복해 바꾸지 않습니다.
명시적인 서비스 생성, `install`, `repair`, `start`는 Codex 연동을 활성화하고 Codex를 프록시로 라우팅합니다.

| 하위 명령 | 동작 |
| --- | --- |
| 없음 | 서비스를 생성/업데이트하고 시작합니다. |
| `install` | 서비스를 생성하고 시작합니다. |
| `repair` | 설치된 서비스를 다시 등록하지 않고 제자리에서 새로 고친 뒤 재시작합니다. |
| `start` | 설치된 서비스를 시작합니다. |
| `stop` | 네이티브 Codex를 복원하고 검증한 뒤 서비스를 중지합니다. 복원을 검증할 수 없으면 서비스와 프록시는 계속 실행됩니다. |
| `status` | 서비스와 프록시 진단, 로그 경로를 보고합니다. |
| `uninstall` | 네이티브 Codex를 복원하고 검증한 뒤 서비스를 제거합니다. |
| `remove` | `uninstall`의 별칭입니다. |

```bash
ccx service
ccx service install
ccx service repair
ccx service status
ccx service uninstall
```

Windows에서는 `ccx service status`가 Task Scheduler 등록 상태를 ID가 검증된 CodexCommander 프록시
도달 가능성과 별도로 보고합니다. 로컬라이즈된 `schtasks` 표는 출력하지 않으므로, 요약은 Windows
코드 페이지에서도 읽기 쉽습니다.

Windows에서 Task Scheduler 항목을 만들려면 권한 상승이 필요합니다. 인식되는 로컬라이즈된
접근 거부 텍스트는 기존 안내 경로를 유지합니다. 그 텍스트를 읽을 수 없으면, 대체 경로는 소유된
명령 형태 `/create /tn codexcommander-proxy /xml <non-empty-path> /f`, 상태 1, 그리고 상승하지
않은 토큰의 확인이 필요합니다. 그러면 대시보드의 Startup Safety 작업이 UAC를 자동으로 요청할 수
있습니다. 그 대체 경로로도 토큰 상태를 판별할 수 없으면 원래 스케줄러 오류를 유지합니다. 외부
작업이나 외부 연산은 자동 권한 상승 표시를 절대 내지 못합니다. 대시보드 UAC 프롬프트를 승인하거나
상승된 PowerShell 창에서 `ccx service install`을 다시 실행해 주세요.

### `ccx codex-shim <install|status|uninstall|remove>`

PATH 위의 스크립트 기반 `codex` 런처를 가벼운 자동 시작 스크립트로 감쌉니다. 정확한 실행 파일
호출을 깨지 않도록 실제 `codex.exe` 대상은 손대지 않습니다.

완료된 외부 Codex 업데이트가 설치된 shim을 덮어쓰면, 다음 일반 `ccx` 명령이 안정적인 새 런처를
백업하고 명령을 처리하기 전에 shim을 복원합니다. 아직 변경 중인 런처는 건드리지 않고 나중에 다시 시도합니다.
복구 실패는 요청한 명령을 실패시키지 않고 경고만 표시합니다. 수동 대체 수단은 `ccx codex-shim install`
입니다. `codexShimAutoRestore`를 `false`로 설정하거나, 프로세스 수준에서 제외하려면
`CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE=0`을 설정합니다.

| 하위 명령 | 동작 |
| --- | --- |
| `install` | shim을 설치합니다(오래된 경우 복구도 수행합니다). |
| `uninstall` | shim을 제거하고 원래 Codex 바이너리를 복원합니다. |
| `remove` | `uninstall`의 별칭입니다. |
| `status` | shim 상태(설치됨, 오래됨, 누락)를 보고합니다. |

```bash
ccx codex-shim install
ccx codex-shim status
ccx codex-shim uninstall
```

:::tip[서비스와 shim]
항상 켜져 있는 백그라운드 프록시에는 `ccx service`를 사용합니다(권장). 데몬 없이 가볍게 필요할
때만 시작하려면 `ccx codex-shim`을 사용합니다. 이 경우 프록시는 `codex`를 실행할 때만 시작됩니다.
:::

### `ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Windows 상태 트레이 아이콘을 설치하고 제어합니다. Windows 로그인 시 시작되며, 프록시를 원클릭으로
제어할 수 있습니다. `start`와 `stop`은 아이콘만 제어합니다. 프록시 제어는 메뉴를 사용하세요.
`--no-start`는 `install`에 적용되며, 트레이를 바로 실행하지 않고 설치합니다.

## 대시보드

### `ccx gui`

프록시가 실행 중이 아니면 자동으로 시작하면서 [웹 대시보드](/guides/web-dashboard/)를
`http://localhost:<port>`에서 엽니다. 수명이 짧고 일회용인 브라우저 시작 티켓으로 확인된 **Apply agent catalog**를 포함한 변경 작업을 사용할 수 있습니다. 티켓은 URL fragment로만 전달되고 교환 중 제거됩니다. 영구 관리자 토큰은 URL이나 Web Storage에 들어가지 않습니다. 확인된 세션은 프로세스 메모리에만 최대 8시간 유지되며 갱신되지 않습니다. 만료 또는 프록시 재시작 후 다음 API 요청은 `401`을 반환합니다. `ccx gui` 또는 macOS 메뉴 앱에서 다시 여세요. loopback 페이지를 직접 열면 API 세션이 발급되지 않으며 영구 관리자 토큰을 요구하거나 전송하지 않습니다.

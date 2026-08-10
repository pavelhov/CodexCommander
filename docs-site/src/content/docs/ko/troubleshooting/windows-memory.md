---
title: Windows 메모리 증가
description: Bun 프로세스가 Windows에서 수 GiB 수준까지 RAM을 늘릴 수 있는 이유, CodexCommander가 현재 무엇을 하고 있는지, 그리고 상위 Bun 수정이 배포되기 전까지 사용할 수 있는 선택지를 설명합니다.
---

일부 Windows 사용자는 CodexCommander 뒤에서 동작하는 `bun` 프로세스가 긴 스트리밍 세션 동안 RSS 기준으로 수 GiB까지 커지는 현상을 봅니다(이슈 [#314](https://github.com/pavelhov/CodexCommander/issues/314)로 보고됨). 이 페이지에서는 실제로 무슨 일이 일어나는지, 그리고 지금 무엇을 할 수 있는지 솔직하게 설명합니다.

## 근본 원인: 상위 Bun 런타임 문제

CodexCommander는 Bun 런타임(현재 **1.3.14**)을 포함합니다. 이 메모리 증가는 프록시의 JavaScript 수준 누수가 아니라 알려진 상위 Bun 이슈들 때문에 발생합니다.

| Bun 이슈 | 상태(확인 시점 2026-07-23) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` 수신 backpressure가 JS 소비와 연결되지 않음 | [PR #29831](https://github.com/oven-sh/bun/pull/29831)로 수정됨. **어느 릴리스에 포함되는지는 확인되지 않았습니다**. 포함되지 않았다고 가정합니다. |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — 클라이언트가 async-pull 스트림을 중단할 때 발생하는 충돌 | 수정 PR [#32120](https://github.com/oven-sh/bun/pull/32120)이 2026-06-21에 머지됨. 1.3.14에는 들어 있다고 가정하지 않습니다. 참고로 이 충돌은 **Windows 전용이 아닙니다**. macOS/Linux에서도 재현되었습니다. |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` 소켓 핸들 누수 | 여전히 상위 저장소에서 **열려 있습니다** |

Windows에서는 CodexCommander가 #32111 충돌을 피하기 위해 스트리밍 응답을 보수적인 코드 경로로 유지해야 하며, 그 경로가 바로 backpressure 문제에 가장 취약합니다. 느리거나 멈춘 클라이언트는 런타임이 상위 데이터를 네이티브 메모리에 버퍼링하게 만들 수 있고, JavaScript는 그 양을 제한할 수 없습니다.

## CodexCommander가 지금 하는 일

완화와 가시성만 제공합니다. **해결책은 아닙니다**. 번들된 1.3.14 런타임에서는 누수 자체가 여전히 상위 문제입니다.

- **메모리 감시기** - 프록시는 1분마다 자체 메모리를 샘플링하고, 관측된 메모리가 4 GiB를 넘으면 속도 제한이 걸린 경고를 기록합니다. 관측된 메모리는 RSS, `external`, `arrayBuffers`의 합이 아니라 그중 가장 큰 값입니다. Windows의 working-set/RSS 카운터가 커밋된 external 잔존량을 낮게 잡을 수 있기 때문입니다.
- **`ccx doctor`** - "Memory / runtime" 섹션에서 *서비스* 프로세스의 Bun 버전, RSS, external/ArrayBuffers 카운터, JS 힙 문맥, 스트림 모드 결정을 보여줍니다. 번들된 Bun 1.3.14 런타임에서는 `heapUsed` / `jscHeap`만으로 누수를 판별할 수 없습니다. 애플리케이션 수준 누수로 단정하기 전에 관측된 메모리, `responseState`, 반복 샘플을 함께 보아야 합니다.
- **`GET /api/system/memory`** - 대시보드나 스크립트에서 쓸 수 있도록 같은 데이터를 인증된 관리 API로 제공합니다. RSS/heap/external 카운터와 함께, 프록시의 메모리 내 `previous_response_id` 이어받기 저장소에 대한 스칼라 `responseState` 블록(항목 수, 직렬화된 총/최대 바이트, 가장 오래된 항목의 경과 시간)을 보고합니다. 이를 통해 증가 원인을 더 잘 구분할 수 있습니다. 관측된 메모리가 함께 증가하면서 `responseState.totalBytes`도 늘면 대화 보존(long `store:false` 체인이 매 턴 다시 확장되는 경우)을 가리키고, 관측된 메모리는 늘지만 `responseState`는 평평하면 그 저장소와는 무관한 원인을 가리킵니다. 값은 스칼라만 포함하며 요청 본문, 토큰, 경로, 계정 식별자는 포함하지 않습니다. 또한 읽기 동작은 부작용이 없습니다. 절대 prune하거나 evict하지 않습니다. 대시보드의 **Memory observability** 카드는 같은 필드를 렌더링하고, 확인을 거쳐야 하는 **Drain & restart** 동작도 제공합니다. 현재 활성 턴 수를 보여주고, 기존 503 + `Retry-After` 드레인과 같은 방식으로 최대 60초 동안 활성 턴을 기다린 뒤, 남아 있는 턴을 강제로 중단하고 Codex 주입을 해제하지 않은 채 라이브 포트의 `ccx start`(또는 실패했을 때만 동작하는 서비스 슈퍼바이저 재기동)를 통해 프록시를 재시작합니다. 이는 `POST /api/stop`의 짧은 드레인보다 더 길고, 더 많은 정보를 반영한 재순환입니다.
- **가드된 대체 스트림 경로** - tee + JavaScript rewrite 체인을 없애는 bounded single-reader relay입니다. Windows rewrite 트래픽에는 이미 사용되며, 일반 Windows 트래픽은 계속 런타임 게이트를 따릅니다. macOS에서는 opt-in plaintext V2 collaboration이 실제로 client rewrite를 활성화하고 검증된 bundled Bun 1.3.14를 실행할 때만 `auto`가 동기식 `pull()` relay를 선택합니다. 이는 [#1127](https://github.com/pavelhov/CodexCommander/issues/1127)의 terminal delivery hang을 해결하는 좁은 경로이며, Bun 1.3.14에 일반 #32111 수정이 포함되었다고 주장하지 않습니다. 다른 macOS rewrite는 명시적 opt-in으로 남습니다. memory endpoint는 in-flight, cancel, abort, error, queue watermark 스칼라 counter만 제공하며 body나 request identity는 포함하지 않습니다.

이 변경들로 실제 RSS가 얼마나 좋아지는지는 **Windows 사용자의 검증을 기다리고 있습니다**. 아직 이 누수가 해결되었다고 말하지는 않습니다.

임계값 기반 자동 재시작은 의도적으로 **제공하지 않습니다**. 프로세스가 충돌하면 서비스 관리자(Task Scheduler/WinSW, launchd, systemd)가 이미 다시 시작합니다.

## 선택지

1. **번들된 런타임 업데이트를 기다립니다.** Bun 릴리스가 수정 사항을 실제로 포함함이 확인되면 CodexCommander가 번들 런타임을 올리고, Windows의 no-rewrite stream path가 자동으로 켜집니다. 위의 macOS plaintext-V2 `auto` 예외는 이와 별도로 특정 Bun 버전에 고정됩니다.

2. **`CCX_BUN_PATH`로 신뢰하는 Bun 런타임을 사용합니다.** 이 경로는 검증되지 않은 영역입니다. CodexCommander를 아직 테스트하지 않은 런타임에서 실행하는 것이므로, 위험은 사용자에게 있습니다. 서비스 설치에서 특히 중요한 점은 이 override가 서비스 시작 시가 아니라 **서비스 아티팩트를 생성할 때** 읽힌다는 것입니다. 환경 변수를 설정한 뒤, 같은 셸에서 `ccx service repair`를 다시 실행해야 경로가 영구적인 서비스 정의에 반영됩니다. 환경 변수만 설정하면 이미 설치된 서비스에는 아무 영향이 없습니다.

3. **`streamMode: "eager-relay"`로 bounded relay를 opt-in합니다.** 방법은 두 가지입니다. `config.json`을 수정해 `"streamMode": "eager-relay"`를 추가하거나, 관리 API에 `PUT /api/settings`와 `{"streamMode":"eager-relay"}`를 보내 새 턴에 재시작 없이 적용합니다. **충돌 위험 경고:** Bun 1.3.14의 일반 async-pull stream은 여전히 #32111의 영향을 받으므로, 검증되지 않은 형태에 eager relay를 강제하면 어떤 OS에서든 프로세스가 충돌할 수 있습니다. 서비스 관리자가 다시 시작하겠지만 진행 중인 요청은 실패합니다. `"safe-tee"`는 tee를 고정하고 macOS plaintext-V2 auto 예외도 끕니다. Windows의 `"auto"`(기본값)는 런타임 게이트를 따릅니다. macOS의 `"auto"`는 검증된 plaintext-V2 collaboration rewrite만 예외로 하고 tee를 유지하며, 명시적 `"eager-relay"`는 다른 적격 SSE 턴을 opt-in합니다.

이 중 어떤 방법이든 실제 Windows 워크로드에 적용해 보셨다면, 변경 전후의 `ccx doctor` 메모리 섹션을 [#314](https://github.com/pavelhov/CodexCommander/issues/314)에 남겨 주세요. 이것이 바로 이 완화책이 기다리고 있는 검증입니다.

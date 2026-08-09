---
title: 설치
description: CodexCommander(ccx) 프록시와 사전 요구 사항을 설치하고, 정상 실행되는지 확인합니다.
---

패키징되거나 로컬로 링크된 빌드에서는 `ccx`와 `codexcommander`라는 두 동등한 명령을 제공합니다.
둘 다 Bun 기반의 작은 로컬 HTTP 서버를 실행합니다. 모델 요청은 라우팅으로 선택된 프로바이더에
전달되며, 필요할 때 vision 및 웹 검색 sidecar가 ChatGPT 로그인을 사용할 수도 있습니다.

## 사전 요구 사항

| 요구 사항 | 이유 |
| --- | --- |
| **[Bun](https://bun.sh)** | 소스 런타임과 저장소 스크립트는 Bun에서 직접 실행됩니다. |
| **[OpenAI Codex](https://openai.com/codex)**(CLI, App, 또는 SDK) | CodexCommander가 앞단에 위치하는 클라이언트입니다. CodexCommander는 `$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 기록합니다. |
| 프로바이더 계정 또는 API 키 | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI API 키, OpenAI 호환 엔드포인트, 또는 ChatGPT 로그인. |

## 소스 체크아웃 실행

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start
```

레지스트리 패키지는 현재 게시되어 있지 않습니다. 이 체크아웃에서는 `ccx <args>`를
`bun run src/cli/index.ts <args>`로 바꿔 실행합니다. 다른 터미널에서 런타임을 확인하세요:

```bash
bun run src/cli/index.ts --version
```

## 개발 모드

UI를 편집할 때는 프록시와 대시보드를 별도 프로세스로 실행하세요:

```bash
bun run dev:proxy   # 개발 모드로 프록시 API 시작 (src/cli/index.ts start)
bun run dev:gui     # 대시보드 dev 서버 시작 (다른 터미널)
```

`bun run dev`는 `bun run dev:proxy`의 별칭입니다. 프록시 API는 `/healthz`,
`/v1/responses`, `/api/*`를 노출하며, `GET /`는 `bun run build:gui`가 `gui/dist`를 생성한
뒤에만 패키징된 대시보드를 서빙합니다. 대시보드를 수정할 때는 `bun run dev:gui`로 프론트엔드를
별도로 실행하세요. macOS 컴패니언은 같은 체크아웃에서 `bun run test:macos && bun run build:macos`로 빌드하며, 소스 빌드는 `dist/macos/CodexCommander.app`에 생성됩니다.

## 생성되는 항목

CodexCommander 상태 파일은 `$CODEXCOMMANDER_HOME`(기본값 `~/.codexcommander`) 아래에, Codex 연동 파일은
`$CODEX_HOME`(기본값 `~/.codex`) 아래에 저장됩니다.

| 경로 | 용도 |
| --- | --- |
| `$CODEXCOMMANDER_HOME/config.json` | 프로바이더, 기본 프로바이더, 포트, 옵션. |
| `$CODEXCOMMANDER_HOME/codexcommander.pid` | 실행 중인 프록시의 PID(단일 인스턴스 가드). |
| `$CODEXCOMMANDER_HOME/runtime-port.json` | 자동으로 고른 대체 포트를 포함한 현재 PID, 호스트명, 포트. |
| `$CODEXCOMMANDER_HOME/auth.json` | 저장된 OAuth 자격 증명(`ccx login` 시). |
| `$CODEXCOMMANDER_HOME/catalog-backup-<catalog-id>.json` | CodexCommander가 수정하기 전에 만든 Codex 모델 카탈로그 백업. |
| `$CODEX_HOME/config.toml` | 로컬 전용 구성에서는 CodexCommander가 관리하는 루트 `openai_base_url`을 추가합니다. 로컬이 아닌 주소에 바인딩할 때는 Codex가 API 인증 헤더를 보낼 수 있도록 `model_provider = "codexcommander"`와 `[model_providers.codexcommander]`를 사용합니다. |
| `$CODEX_HOME/codexcommander.config.toml` | 기본 Codex 설정과 함께 생성되는 참고용 fallback 프로필. |
| `$CODEX_HOME/codexcommander-catalog.json` | Codex가 사용하는 네이티브 및 라우팅 모델 카탈로그. |

:::note
CodexCommander는 절대 Codex 설정을 삭제하지 않습니다. 모든 주입은 되돌릴 수 있습니다 — `ccx stop`, `ccx restore`,
또는 `ccx eject`는 CodexCommander가 추가한 줄만 정확히 제거하고 네이티브 Codex를 복원합니다.
:::

## 다음

[Quickstart](/ko/getting-started/quickstart/)로 이동해 첫 프로바이더를 설정하거나,
아키텍처를 알아보려면 [작동 방식](/ko/getting-started/how-it-works/)을 읽어 보세요.

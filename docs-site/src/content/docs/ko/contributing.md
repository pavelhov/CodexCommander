---
title: 기여하기
description: CodexCommander 개발 환경, 구조, 규칙, 프로바이더와 어댑터 추가 방법.
---

## 설정

```bash
cd /path/to/CodexCommander
bun install
bun run dev:proxy    # 개발 모드 프록시 API
bun run dev:gui      # 대시보드 dev 서버(다른 터미널)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev`는 계속 `bun run dev:proxy`의 별칭으로 동작합니다. 대시보드 dev 서버는
`bun run dev:gui`이며, `GET /`에서 제공하는 패키지 대시보드는 `bun run build:gui`로 빌드해
`gui/dist`에 만듭니다.

## 빌드 및 테스트 명령

루트 패키지는 Bun 네이티브 TypeScript이며 서버를 따로 compile하는 단계가 없습니다. 저장소에
정의된 스크립트를 사용하면 로컬 실행과 CI를 맞출 수 있습니다.

```bash
bun run typecheck                 # 엄격한 TypeScript 검사
bun run test                      # tests/ 전체 스위트
bun test tests/router.test.ts     # 특정 테스트 파일
bun run build:gui                 # Vite GUI 빌드 + 패키지 준비
bun run privacy:scan              # CI에서 쓰는 자격 증명/개인정보 검사
bun run prepare:package           # 패키지 런처/asset 갱신
```

대부분의 테스트는 `tests/*.test.ts`에 나란히 놓인 Bun 테스트입니다. 공용 fixture는
`tests/helpers/`, 범위가 넓은 네이티브 동등성 시나리오는 `tests/e2e-style/`에 있습니다. 바꾼
subsystem의 기존 테스트 근처에 집중된 회귀 테스트를 추가하세요. 공용 라우팅, 어댑터, 설정, 서버
동작을 건드렸다면 전체 스위트도 실행합니다.

지금 읽고 있는 문서 사이트는 `docs-site/`에 있습니다(Astro + Starlight).

```bash
cd docs-site && bun install && bun dev
```

## 문서 사이트

문서는 `docs-site/`에 있으며 현재 게시된 호스트는 없습니다. 문서 PR을 열기 전에 로컬에서 빌드하세요.

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

게시 자동화는 이 저장소에 포함되어 있지 않습니다.

## 지속적 통합

모든 pull request와 `main`으로의 모든 push에는 자동 검사가 **하나** 있습니다: **`ci`**
(`.github/workflows/ci.yml`). 일반 기여에 필요한 자동화는 이것뿐입니다.

저장소 관리자는 보호 규칙이 의도한 관리 작업을 막을 때 GitHub ruleset **Always-allow**
bypass를 사용할 수 있습니다. 관리자 복구와 예외 유지보수용이며, 기여자 작업의 리뷰를
대체하지 않습니다.

## 브랜치와 pull request

- **`main`이 유일한 default/통합/PR 대상입니다.** 기능·수정 PR은 `main`으로 여세요.
- 현재 **`main` tip**에서 브랜치를 따세요.
- 설명에는 무엇을 왜 바꿨는지와 검증 방법(실행한 명령과 결과)을 적으세요. 비어 있거나
  placeholder만 있는 설명은 리뷰 준비가 아닙니다.
- 대시보드 UI를 건드리면 설명에 스크린샷을 넣으세요.
- 동작 변경에는 해당 서브시스템 기존 테스트 근처에 집중 회귀 테스트가 필요합니다. 공유
  라우팅/어댑터/설정/서버 변경은 전체 suite를 통과해야 합니다.

`main`의 Bun 네이티브 TypeScript가 단일 런타임 라인입니다.

리베이스 PR은 환영합니다. 오래된 브랜치를 현재 head로 맞추는 것은 평범한 유지보수입니다.
설명에 출처 커밋을 적어 주세요.

## 컨벤션

- **ES Modules 전용**(`import`/`export`), TypeScript, `strict` 모드. `bun x tsc --noEmit`을 깨끗하게
  유지하세요.
- **파일당 최대 약 500줄** — 책임별로 나누세요. 단일 `index.ts` 뒤에 작고 집중된 모듈을 둔
  `web-search/`와 `vision/` 사이드카가 좋은 예입니다.
- **비동기 오류는 경계에서 처리** — 사이드카는 요청 경로로 오류를 던지지 않고 적절한 marker로
  저하됩니다.
- **Structure SOT** — 현재 유지보수 불변식은 `structure/`에 둡니다. 공개 사용자 워크플로는
  `docs-site/`, 유지 관리되는 기술·구현 노트는 `docs/`에 둡니다.
- **export 보존** — 다른 모듈이 의존할 수 있습니다.

## 카탈로그에 프로바이더 추가하기

모든 프로바이더 선택기와 seed는 canonical registry(`src/providers/registry.ts`)에서 파생됩니다.

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts`는 이 항목을 `ccx init`, `ccx provider`, 대시보드 preset, API 키 로그인,
OAuth 설정 seed에 공급합니다. `enrichProviderFromCatalog()`는 모델 메타데이터와 capability 분류를
저장할 프로바이더 설정에 복사합니다. OAuth 프로토콜 구현은 여전히 `src/oauth/`에 있습니다.
레지스트리 메타데이터만 추가해서 OAuth flow가 생기지는 않습니다.

## 어댑터 추가하기

`src/adapters/`에 `ProviderAdapter`([어댑터](/ko/reference/adapters/) 참조)를 구현하고,
`src/server/adapter-resolve.ts`에 이름을 등록한 뒤 출력을 내부 `AdapterEvent`로 브리징하세요. 이미지
처리에는 `image.ts`를 재사용하고, 일반적인 스트리밍/툴 호출은 `openai-chat.ts`를 참고합니다.
어댑터가 전송 재시도를 직접 맡을 때만 `fetchResponse`를 사용하고, Cursor처럼 실제 양방향 전송에는
`runTurn`을 사용하세요. `tests/` 아래에 집중된 테스트를 추가하고, public package API에 포함되는
factory라면 `src/index.ts`에서도 export합니다.

## 완료를 주장하기 전에 검증하기

변경을 증명하는 가장 좁은 명령부터 실행하세요. 타입은 `bun run typecheck`, 동작은 집중된
`bun test tests/<name>.test.ts` 또는 런타임 probe로 확인한 뒤 영향 범위에 맞는 넓은 gate를
실행합니다. CodexCommander는 큰 batch보다 작고 검증 가능한 commit을 선호합니다.

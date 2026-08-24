# project-geny-app — Architecture & Build Plan

> Geny의 모든 기능을 **단일 사용자용 데스크톱 앱** 하나로 재구성한다.
> 다운로드 → 실행 → 바로 동작. 서버 없음, Docker 없음, 수동 설치 없음.

---

## 0. 무엇을 만드는가

| | Geny (현재) | project-geny-app (신규) |
|---|---|---|
| 배포 | docker compose 5개 컨테이너 + nginx | 설치 파일 1개 (dmg / exe / AppImage·deb) |
| 사용자 | 멀티 유저 + 로그인 + admin | **1인 사용자, 로그인 없음** |
| 백엔드 | FastAPI 서버(라우터 57개, 엔드포인트 ~450) | **앱이 전부 소유** (Electron main + Python 사이드카) |
| 저장소 | PostgreSQL + qdrant | **SQLite** (앱 데이터) + 파일 메모리 |
| LLM | 5 provider | **anthropic · openai · claude_code_cli** |
| 제거 | — | GAPT(샌드박스) · 클라우드/동기화/WebDAV · 오디오 자체 서빙 · 인증/admin |

---

## 1. 핵심 결정 8가지

### D1. 에이전트 엔진은 Python 사이드카로 동봉한다 (TS 재작성 안 함)
`geny-executor` 2.65.4가 엔진 전체(21-stage 파이프라인, 36개 내장 도구, MCP, 스킬, 메모리, HITL)를
이미 갖고 있고 **서버 없이 단독 구동된다**. 직접 실증:

```
uv pip install geny-executor          → 181MB, 서버 0개
Pipeline.run_stream("안녕")            → 35 events (text.delta 포함) 스트리밍
resident daemon 2턴 연속 + clean shutdown → PASS
```

엔진을 TS로 옮기면 773개 Python 파일 + Geny의 5,664줄 세션 계층을 재작성해야 하고 그 순간
"Geny의 기능을 전부"라는 요구가 깨진다. → **엔진은 그대로 쓰고, 그 위의 서버 계층만 앱으로 옮긴다.**

### D2. 사이드카는 상주 asyncio 데몬 + JSON-lines stdio
턴마다 Python을 새로 띄우면 (Windows 수 초) 첫 토큰이 늦고, MCP 자식 프로세스·claude-CLI hot spare·
cron·백그라운드 태스크·메모리 인덱스가 매 턴 재생성된다. xgen-connector가 v1(턴마다 spawn) →
v2(상주 데몬)로 갈아탄 이유와 동일.
- `python -I -X utf8 -u -m geny_app.sidecar --serve`
- **fd 1 복제 후 `sys.stdout`을 stderr로 리다이렉트** — 라이브러리의 `print()`가 프로토콜을 깨지 못하게
- 턴 = asyncio task (스레드 아님 — 엔진이 asyncio-native, 크로스루프 사고 방지)
- `dict[session_id → Pipeline]` 상주, idle evict 시 `aclose()`

### D3. Python은 PBS `install_only_stripped` + 미리 설치된 site-packages를 resources에 동봉
| 방식 | 판정 |
|---|---|
| A. PBS + prebaked site-packages | **채택** — 오프라인 동작, 실측 169MB(→gzip 49MB) |
| B. 첫 실행 시 다운로드 | 자가치유 단계로만 유지 (네트워크 의존 = "바로 동작" 위반) |
| C. PyInstaller/Nuitka freeze | 거부 — MCP/CLI 자식 spawn·플러그인 로딩과 충돌 |
| D. TS 재작성 | 거부 — D1 참조 |

실측: `install_only_stripped` 30MB→99MB, test/idlelib/tkinter/tcl 제거 후 **78MB**.
**직접 strip 금지** (해보니 인터프리터 파손 — 공식 stripped 애셋만 사용).

### D4. 의존성은 앱 전용으로 잘라 쓴다
`numpy`는 선언돼 있지만 **엔진 어디서도 import 하지 않는다**(58MB 사장). `psycopg`/`pgvector`는
Postgres 메모리 provider 전용(우리는 SQLite), `google-genai`는 범위 밖.
- **base**: anthropic · mcp · pydantic · jsonschema · httpx · websockets · pyyaml · croniter · ddgs · openai → **89MB**
- **feature pack (선택 설치)**: `edit2docs`(문서 141MB) · `an-web`(브라우저 106MB) — 엔진이 이미
  미설치 시 안내 메시지를 내므로 존재 여부로 자동 게이팅
- Windows에서 `docx2pdf` 절대 동봉 금지 (실제 MS Word 필요)

### D5. 영속은 SQLite 하나로 — 드라이버는 Node 내장 `node:sqlite`
Electron 43은 Node 24를 싣고 있어 `node:sqlite`(DatabaseSync)를 그대로 쓸 수 있다(실측 확인).
better-sqlite3은 플랫폼마다 Electron ABI에 맞춘 node-gyp 재빌드가 필요하고 **이 머신에서 실제로
빌드가 깨졌다** — "다운로드 후 실행"을 깨는 바로 그 부류. 내장 드라이버 채택으로 **네이티브 의존성 0개**.

Geny는 Postgres 17테이블(ORM 없음) — `BaseModel`이 이미 SQLite DDL을 뱉으므로 `DatabaseManager`만
교체. 에이전트 메모리는 엔진의 **file provider**(순수 파이썬), RAG는 Geny의 `synapse_store.py`
(API 호출 0, SQLite 1파일)를 기본값으로. qdrant/OpenAI 임베딩은 선택.

### D6. 프로세스는 4계층 + 타입 계약 하나 (orca 방식)
`main` / `preload` / `shared` / `renderer`. 프로세스 간 유일한 계약은 `shared/`의 타입.
main 코어 로직은 `import 'electron'` 금지 — settable singleton(`setAppEnvironment`)으로 주입해
평범한 Node에서 단위 테스트 가능하게. **xgen-connector의 3,330줄 index.ts는 반복하지 않는다.**

### D7. UI는 VS-Code 형태 단일 윈도우
activity rail(Agents · Memory · Library · Help) + 사이드바 + 에이전트별 탭
(Chat · Files · Tasks · Transcript · Config) + 컨텍스트 인스펙터.
Geny의 "헤더에서 외부 페이지로 튀는" 구조는 재현하지 않는다. React 19 + Zustand + Tailwind.

### D8. 데이터 루트는 portable 우선, userData 폴백
사용자 요구는 "앱 설치 하위에 에이전트 워크스페이스". macOS `.app`/Windows `Program Files`는
서명·권한 때문에 쓰기 불가이므로:
1. 앱 옆 `./geny-data/`가 쓰기 가능하면 **거기** (포터블 모드 — USB/개발 트리에서 요구 그대로 충족)
2. 아니면 `userData/geny-data/` + 설정에서 경로 변경 + "폴더 열기" 버튼

```
<data-root>/
  app.db                    SQLite (에이전트·세션·메시지·설정·MCP·권한)
  secrets/                  API 키 (OS 키체인 우선, 폴백 암호화 파일)
  agents/<agent-id>/
    workspace/              ← 에이전트의 작업 디렉터리 (도구 path jail)
    memory/                 파일 메모리 provider 루트
    sessions/<sid>.json     PipelineState 스냅샷
    artifacts/              산출물
  runtime/python/           동봉 CPython 복사본 (자가치유 대상)
  packs/                    선택 feature pack (docs·browser)
  logs/
```

---

## 2. 시스템 구조

```
┌─────────────────────────────────────────────────────────────┐
│ renderer (React 19 · Zustand · Tailwind)                    │
│  Agents │ Memory │ Library │ Help    ← activity rail        │
│  window.geny.* (preload가 노출한 타입 있는 API만)             │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC (domain:verbNoun) + 스트림 채널
┌───────────────────────▼─────────────────────────────────────┐
│ main (Electron)                                              │
│  · 윈도우/트레이/단축키/알림/업데이터                          │
│  · SQLite(app.db) · 시크릿(키체인) · 데이터루트                │
│  · 에이전트/세션 레지스트리 · 워크스페이스 생성                 │
│  · 사이드카 감독(SidecarDaemon) · 런타임 자가치유              │
│  · MCP 설정 소유(실제 spawn은 엔진이) · CLI 탐지/설치          │
└───────────────────────┬─────────────────────────────────────┘
                        │ JSON-lines stdio (protocol v1)
┌───────────────────────▼─────────────────────────────────────┐
│ python sidecar (geny_app.sidecar — 상주 asyncio)             │
│  dict[session_id → Pipeline]                                 │
│  geny-executor: 21 stages · 36 tools · MCP · skills · memory  │
│  provider: anthropic │ openai │ claude_code_cli               │
└─────────────────────────────────────────────────────────────┘
```

### 사이드카 프로토콜 v1
**명령(→ python)**
| op | 필드 | 뜻 |
|---|---|---|
| `turn` | `id, session, text, config, context` | 한 턴 실행 |
| `cancel` | `id, target` | 협조 취소 |
| `prompt_reply` | `id, prompt_id, value` | AskUserQuestion 응답 |
| `hitl` | `id, token, decision` | 권한/승인 결정 → `pipeline.resume` |
| `refresh` | `id, session, runtime` | 키 회전·작업디렉터리 변경 |
| `evict` | `id, session` | `aclose()` 후 제거 |
| `ping` / `shutdown` | `id` | 헬스/종료 |

**이벤트(← python)** — 턴당 **정확히 하나의 종결 이벤트**
`ready` `pong` `started` `event`(엔진 121종 그대로) `chunk` `tool` `prompt` `hitl_request`
`usage` `meta` `notice` `done` `cancelled` `error`
취소를 관측한 턴은 스트림이 자연 종료돼도 `cancelled`로 닫는다(xgen이 겪은 done/cancel 경합).

### 한 턴의 엔진 호출 (실증된 경로)
```python
m = build_manifest("worker_adaptive", provider="anthropic", model=...,
                   built_in_tools=[...])
m.memory = {"provider": "file", "config": {"root": f"{agent}/memory", "session_id": sid}}
p = await Pipeline.from_manifest_async(m, credentials=CredentialBundle(...))
p.attach_runtime(tool_context=ToolContext(
    session_id=sid, working_dir=f"{agent}/workspace", storage_path=agent,
    allowed_paths=[f"{agent}/workspace"], permission_mode="default",
    extras={question_handler, task_registry, cron_store, mcp_manager, web_search, ...}))
async for ev in p.run_stream(text, state):   # state는 호스트가 소유·영속
    emit(ev)
await p.aclose()                              # 세션 축출 시 필수
```
호스트 서비스는 `ToolContext.extras`(DI dict) + `attach_runtime` kwargs + Stage15 `Requester`
세 경로로만 주입된다. 파일/셸은 주입 대상이 아니라 **`allowed_paths` + `permission_rules`로 격리**.

---

## 3. 기능 범위 (Geny → 앱)

**KEEP (앱으로 이식)**
에이전트 세션/턴 · 채팅·대화 · 도구 시스템/카탈로그 · 도구 정책·권한(점진 공개) · 도구 프리셋 ·
자기제작 도구(forged) · MCP(커스텀·OAuth·시크릿) · 스킬(SKILL.md) · 슬래시 커맨드 · 서브에이전트·위임 ·
백그라운드 태스크 · 메모리(Synapse/Opsidian) · 지식/RAG(SQLite) · 훅·자동화 · cron · 알림 ·
LLM 백엔드·자격증명 · 페르소나 · 환경(21-stage 매니페스트) · 워크스페이스/파일 · 설정 · 아바타(선택)

**SIMPLIFY (아이디어는 유지, 서버·멀티유저 기계 제거)**
세션 소유권/공유 → 전부 내 것 · 승인 거버넌스 → 로컬 권한 프롬프트 ·
관리자 설정 → 설정 화면 · 텔레메트리 → 로컬 로그 · 업데이트 로그 → 릴리스 노트

**DROP**
GAPT/샌드박스(도구 3개 + docker exec) · 클라우드/파일저장소/동기화/WebDAV/FUSE ·
오디오 자체 서빙(whisper-stt·omnivoice 컨테이너) — STT/TTS는 **외부 엔드포인트 위임만** ·
인증/로그인/IP ACL/관리자 · nginx/게이트웨이 · Postgres/qdrant 필수화 · 3D 도시 시각화(후순위)

---

## 4. 구현 로드맵

| M | 목표 | 산출물 | 수락 테스트 |
|---|---|---|---|
| **M0** | 걷는 해골 | electron-vite+React 셸, 사이드카 데몬, 한 턴 스트리밍 | 앱 실행 → API키 입력 → "안녕" → 토큰 스트리밍 표시 |
| **M1** | 실제 도구 | ToolContext/path jail, Bash·Read·Write·Edit·Glob·Grep, 도구 카드 UI | 에이전트가 워크스페이스에 파일 생성, UI에 도구 카드 |
| **M2** | 영속 | SQLite 스키마, 에이전트/세션 CRUD, PipelineState 저장·복원 | 앱 재시작 후 대화 이어짐 |
| **M3** | 권한·HITL | permission_rules, hitl_request→UI 승인, AskUserQuestion | 위험 Bash 실행 시 승인 다이얼로그 → 승인/거부 반영 |
| **M4** | 백엔드 3종 | anthropic·openai·claude_code_cli, CLI 탐지/설치, 모델 선택 | 세 백엔드로 각각 한 턴 성공 |
| **M5** | 패키징 | PBS 번들 스크립트, electron-builder, 자가치유 사다리 | 클린 머신에서 설치 파일만으로 M0~M4 동작 |
| **M6** | MCP·스킬·슬래시 | MCP 서버 관리 UI, 스킬 레지스트리, 슬래시 커맨드 | MCP 서버 추가 → 도구 목록 등장 → 호출 성공 |
| **M7** | 메모리·지식 | 파일 메모리 + Synapse, Opsidian 브라우저 | 세션 간 사실 회상, 메모리 화면에서 열람 |
| **M8** | 태스크·cron·훅 | 백그라운드 태스크, cron, 훅 자동화, 알림 | 예약 작업이 앱 재시작 후에도 발화 |
| **M9** | 파일·산출물 | Files 탭(트리·미리보기·업로드), 아티팩트 | 산출물 미리보기·다운로드 |
| **M10** | 서브에이전트·환경 | 위임 트리 UI, 환경 빌더(21-stage), 프리셋 | 서브에이전트 위임이 트리로 보임 |
| **M11** | 마감 | 아바타 오버레이(선택), 퀵챗 핫키, 온보딩, 업데이터 | 첫 실행 온보딩 → 5분 내 첫 턴 |

각 M은 독립 검증 가능하고, M0부터 항상 실행되는 앱이 존재한다.

---

## 4-A. M0 실증 기록 (2026-08-24)

걷는 해골이 실제로 통과한 검증 — 추정이 아니라 실행 결과:

```
✓ window opened — Geny
✓ preload API exposed
✓ data root: /tmp/geny-app-XXXX
✓ engine: ready   executor 2.65.4 · py 3.12.3
✓ agent created:  <data-root>/agents/<uuid>
✓ turn events:    started → event ×N  (Electron → 사이드카 → 엔진 → 렌더러)
```

**M1(실제 도구)까지 실증** — `claude_code_cli` 백엔드로 실 모델 턴:
```
✓ turn closed: tool:Write:start · tool:Write:result · done
  assistant: "File proof.txt has been written with the specified content."
✓ 워크스페이스에 실제 파일 생성: proof.txt = "hello-from-geny-…"
```

### 도구 실행 위치의 비대칭 (반드시 알아야 하는 계약)

| 백엔드 | 도구를 실행하는 주체 | 격리 수단 |
|---|---|---|
| `anthropic` · `openai` | **엔진**(사이드카 프로세스 내) | `ToolContext.allowed_paths` 경로 감옥 + `permission_rules` |
| `claude_code_cli` | **CLI 자신**(별도 프로세스, 자기 cwd·자기 권한 모델) | CLI 의 cwd(=우리가 지정한 워크스페이스) + CLI 권한 모드 |

CLI 백엔드에서 `workspace_dir`를 주지 않으면 CLI가 **사이드카의 cwd**를 물려받아
**앱 소스 트리에 파일을 쓴다**(실측: repo 루트에 x.txt 생성). 또 CLI 기본 권한 모드는
tty 가 없는 자식 프로세스에서 물어볼 수단이 없어 **모든 편집이 거부되고 에이전트가 재시도 루프**에
빠진다(실측). → `ProviderCredentials.extras`에 `workspace_dir` + `default_permission_mode:
acceptEdits` 를 주입한다.

과정에서 잡은 실제 결함·함정 (모두 수정/기록):
| 발견 | 내용 |
|---|---|
| **조용한 실패** | `run_stream`은 엔진 오류를 예외로 던지지 않고 `api.error`/`pipeline.error` **이벤트**로 흘린다. 초기 구현은 이를 `done`으로 닫아 실패를 성공으로 보고했다 → 실패 이벤트 어휘를 감시해 `error`로 종결 |
| **SDK 메이저 파괴** | `geny-executor`의 `anthropic>=0.52`가 **1.0.0**을 끌어와 `stream(temperature=)` 제거로 전 턴 실패. 프로드 Geny가 쓰는 0.12x로 고정 + 계약 테스트 |
| **`-I`는 PYTHONPATH를 무시** | 격리 플래그라서 dev에서 env 경유가 불가 → site-packages에 `.pth` (프로드는 트리에 동봉) |
| **numpy 사장 58MB** | 엔진 어디서도 import 안 함 → 제거. 181MB → **94MB** |
| **네이티브 빌드 파손** | better-sqlite3 node-gyp 실패 → `node:sqlite` 채택(네이티브 0개) |
| **ELECTRON_RUN_AS_NODE** | 켜져 있으면 `require('electron')`이 API가 아니라 경로를 준다 |
| **Linux chrome-sandbox** | SUID 미설정 시 SIGTRAP — 패키징 postinst에서 4755 강제 필요 |
| **CLI 가 앱 소스에 씀** | `workspace_dir` 미주입 시 CLI 가 사이드카 cwd 상속 → repo 루트에 파일 생성 |
| **CLI 권한 교착** | tty 없는 자식에서 기본 권한 모드는 물어볼 수 없어 전 편집 거부·재시도 루프 |
| **가드 체인 미설치** | `build_manifest`가 빈 체인에 순서를 선언 → `chain.order_unappliable`로 **권한 가드 포함 전부 미설치**. 앱이 정책을 소유할 때까지 선언 제거 |
| **도구 이벤트 4중복·이름 없음** | `api.tool_use`+`api.cli_tool_call` × (빈 입력→전체 입력) = 카드 4개, 결과엔 이름 없음 → tool_use_id 로 dedupe·이름 역참조 |

## 5. 위험과 대응

| 위험 | 대응 |
|---|---|
| Python 동봉 실패(플랫폼별 트리 손상) | `import` 스모크 기반 자가치유 사다리(설치본→동봉본 복사→네트워크) + afterPack 검증 게이트 |
| Windows MAX_PATH로 반쪽 복사 | `\\?\` 긴 경로 접두 (xgen-connector 실전 해법 재사용) |
| 서명 없음(SmartScreen/Gatekeeper) | 초기엔 무서명 + 안내 문서, 이후 서명 도입 |
| 프로토콜 오염(라이브러리 print) | fd 복제 + stdout→stderr 리다이렉트 (필수) |
| `build_manifest`가 Stage4 guard를 건너뜀 | 앱에서 예산 guard 명시 설치 + 회귀 테스트 |
| 권한 기본값이 no-match→allow | 앱은 **기본 거부**로 오버라이드 |
| feature pack 미설치 상태 | 엔진의 안내 메시지 그대로 노출 + 설정에서 1클릭 설치 |

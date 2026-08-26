<h1 align="center">project-geny-app</h1>

<p align="center"><em>Geny를, 서버 없이, 앱 하나로.</em></p>

<p align="center">
다운로드 → 실행. Docker 없음 · 서버 없음 · Python 수동 설치 없음.<br/>
<b>Anthropic</b> · <b>OpenAI</b> · <b>Claude Code CLI</b> 를 한 앱에서.
</p>

<p align="center">
  <a href="https://github.com/CocoRoF/project-geny-app/releases/latest"><b>➡️ 설치 파일 받기</b></a>
</p>

---

## 무엇인가

[Geny](https://github.com/CocoRoF/Geny)는 컨테이너 5개와 Postgres 를 띄우는 멀티유저 플랫폼입니다.
이 프로젝트는 그 **기능을 1인 사용자용 데스크톱 앱 하나**로 재구성합니다.

| | |
|---|---|
| **에이전트** | 백엔드 3종, 에이전트별 모델 · 권한 · 시스템 프롬프트 |
| **도구** | 41종 — 엔진 25(파일 · 셸 · 웹 · 백그라운드 · 예약 · 위임 · MCP) + **이 앱만 하는 것 16**(화면 캡처 · 알림 · 클립보드 · 브라우저 · 지식 · 음성). 에이전트별 on/off |
| **격리** | 에이전트마다 자기 워크스페이스. 도구는 그 밖으로 나갈 수 없습니다 |
| **권한** | 신중 / 표준 / 신뢰 — 위험한 작업은 앱이 **묻고**, 거부하면 실행되지 않습니다 |
| **대화 영속** | 앱을 껐다 켜도 대화와 **엔진 컨텍스트**가 이어집니다 |
| **MCP** | 서버 등록 → 에이전트별 on/off. *실제로 연결됐는지* 엔진에 물어 보여줍니다 |
| **파이프라인** | 엔진의 21단계를 실제 구성 그대로 봅니다 — 어떤 전략이 붙어 있는지 |
| **지식** | `<데이터>/knowledge` 에 문서를 넣으면 에이전트가 검색해 읽습니다 — 로컬 색인, API 호출 0 |
| **훅** | 외부 프로그램이 도구 호출을 지켜보고 **막을 수 있습니다** — `<데이터>/hooks/hooks.yaml` |
| **페르소나** | 역할·규칙·모델·도구를 한 묶음으로. `<데이터>/personas/*.md` — 열어서 고칠 수 있습니다 |
| **스킬 · 명령어** | `<데이터>/skills`, `<데이터>/commands` 에 넣으면 자동 인식 |
| **기억** | 에이전트가 무엇을 기억하는지 — 장기 기억 · 카테고리별 메모 · 대화 기록. 읽기 전용 |
| **파일** | workspace · artifacts · memory 탐색, 텍스트/이미지 미리보기 |
| **백그라운드** | Task(파일 영속) · Cron(러너가 실제로 발화) — 예약이 있는 세션은 정리하지 않습니다 |
| **위임** | 서브에이전트에 일을 맡기고 그 활동을 대화에 표시 (worker · researcher · summarizer · critic) |
| **퀵챗** | `Ctrl/Cmd+Shift+G` — 다른 앱 위에 떠서 바로 묻고 답을 받습니다. 트레이 상주 |
| **브라우저** | 에이전트가 실제 브라우저 창을 조작합니다 — 열기 · 요소 스냅샷 · 클릭/입력 · 본문 읽기 |
| **아바타** | 바탕화면 위에 떠서 생각·발화·승인 대기에 반응하고, 음성 파형에 맞춰 입을 움직입니다. **MMD**(PMX)는 앱이 직접 렌더링 · **Live2D**는 렌더러 동봉 + Cubism Core 원클릭 · Spine · 이미지/영상 · 자체 페이지 |
| **음성** | 받아쓰기·말하기를 **호출**합니다 — Geny `geny-audio-services`(omnivoice · whisper) · OpenAI · 직접 지정 · OS 내장. 누르고 말하기 · 답변 자동 낭독 |

제거된 것: GAPT(샌드박스) · 클라우드/동기화 · **오디오 자체 서빙** · 로그인/관리자.
음성은 서빙하지 않고 **연결**합니다 — GPU 서버에 [`geny-audio-services`](https://github.com/CocoRoF/geny-audio-services)
를 띄웠다면 주소만 적으면 됩니다.

## 설치

[Releases](https://github.com/CocoRoF/project-geny-app/releases/latest) 에서 받으세요.

| OS | 파일 | 첫 실행 |
|---|---|---|
| **Windows** | `Geny_app_windows_*.exe` | SmartScreen → **추가 정보 → 실행** (현재 무서명) |
| **macOS** | `Geny_app_macos_arm64_*.dmg` · `Geny_app_macos_x64_*.dmg` | Applications 로 드래그 → **우클릭 → 열기** (Gatekeeper, 무서명) |
| **Linux** | `Geny_app_linux_*.AppImage` | `chmod +x` 후 실행 · 또는 `sudo apt install ./Geny_app_linux_*.deb` |

파이썬도 API 서버도 따로 설치할 필요가 없습니다 — 엔진이 설치 파일에 들어 있습니다.
첫 실행에서 **Anthropic API 키**를 넣거나, `claude` CLI 가 이미 있으면 그대로 씁니다.

설치 위치는 `/opt/Geny App` 입니다 — `geny-connector` 가 `/opt/Geny` 를 쓰고 있어서
같은 디렉터리를 쓰면 dpkg 가 설치를 거부합니다. 두 앱은 나란히 설치됩니다.

**Linux 참고** — Ubuntu 24.04 는 `kernel.apparmor_restrict_unprivileged_userns=1` 때문에
Electron 앱의 샌드박스가 막히는 경우가 있습니다. `.deb` 는 AppArmor 프로파일을 함께 설치해
이를 처리하고, AppImage 는 24.04.4 에서 그대로 실행되는 것을 확인했습니다
(`--no-sandbox` 불필요). 자동 업데이트는 AppImage 만 지원합니다 — `.deb` 로 설치했다면
새 `.deb` 를 받아 설치하세요(앱이 그렇게 안내합니다).

## 구조

```
Electron main ──JSON-lines stdio──> Python 사이드카 (geny-executor)
  윈도우 · SQLite · 시크릿 · IPC        21 stages · 도구 · MCP · 메모리
      │
      └─> renderer (React 19 · Zustand)
```

에이전트 엔진은 Python(`geny-executor`)을 그대로 씁니다 — 앱은 그 위의 *서버 계층*을
대체합니다. 결정 근거와 기각한 대안은 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**네이티브 모듈 0개** — 저장소는 Node 내장 `node:sqlite`.

## 개발

```bash
npm install
npm run engine:venv     # engine/.venv 에 파이썬 엔진 설치 (uv 필요)
npm run engine:smoke    # 사이드카 프로토콜 검증 (API 키 불필요)
npm run dev             # 앱 실행
npm run dist            # 파이썬 동봉 → 검증 → 인스톨러
```

| 검증 | 무엇을 보장하나 |
|---|---|
| `npm run engine:smoke` | ready → ping → turn → 종결 이벤트 정확히 1개 → 정상 종료 |
| `npm test` | SDK 핀, 제거된 의존성 부재, TurnConfig 필드 완전성 |
| `node test/app-launch.mjs` | 앱 실행 · preload 전면 · 온보딩 · 엔진 · 에이전트 · 파일 격리 · MCP |
| `node test/m2-persistence.mjs` | 앱을 두 번 띄워 대화·엔진 컨텍스트 복원 (모델 필요) |
| `node test/m6-mcp.mjs` | MCP 서버가 연결돼 도구가 에이전트에 도달 (모델 필요) |
| `node test/capability-probe.mjs` | 엔진이 **실제로 로드한** 도구 목록 (모델 필요) |
| `node test/host-tool-roundtrip.mjs` | 앱의 도구를 엔진이 호출하고 결과가 모델에 도달 (모델 필요) |
| `node test/tool-selection.mjs` | 에이전트별 도구 on/off 가 엔진에 반영 (모델 필요) |
| `node test/quick-chat.mjs` | 전역 단축키 등록 · 퀵챗이 본 창과 상태 공유 |
| `node test/browser-tools.mjs` | 에이전트 브라우저가 실제로 입력·클릭·읽기 수행 |
| `node test/personas.mjs` | 페르소나가 에이전트의 프롬프트·태도·도구를 실제로 구성 |
| `node test/memory-browser.mjs` | 엔진이 기록한 기억을 앱이 읽고, 경로 탈출을 거부 |
| `engine/.venv/bin/python test/hooks_engine_test.py` | 훅이 실제로 셸 실행을 차단 (모델 불필요) |
| `node test/knowledge.mjs` | 문서 색인·검색 (한국어 2글자 질의 포함) |
| `node test/avatar.mjs` | PMX 모델이 WebGL 에 실제로 로드(모프·물리 확인)·클릭 통과·재시작 복원 |
| `node test/avatar-formats.mjs` | Live2D · Spine · 이미지 인식, 표시용 페이지 생성, 런타임 없을 때/있을 때 동작 |
| `GENY_LIVE2D_SAMPLE=<모델폴더> node test/live2d.mjs` | 실제 Live2D 모델 — Core 내려받기·검증, 실제 렌더링(가시 픽셀 확인) |
| `node test/voice.mjs` | 스텁 서비스에 실제로 보낸 요청 검증 — omnivoice clone 필드 · whisper multipart · 로딩중 판별 |
| `engine/.venv/bin/python test/permission_engine_test.py` | 승인 요청이 사용자에게 도달하고 승인/거부가 반영 |
| `node scripts/verify-bundle.mjs` | 동봉 파이썬이 실제로 돌고 프로토콜을 말하는지 |
| `node test/packaged-app.mjs <AppImage>` | **출시본**이 실제로 동작 — 동봉 엔진 · asar 안의 아바타 엔트리 · 물리 wasm · 설정 영속 |
| `python3 scripts/make-icons.py` | 앱·트레이 아이콘 재생성 (코드가 정의, 바이너리는 산출물) |

Linux 개발 실행에서 `chrome-sandbox` SUID 가 없으면 SIGTRAP — `--no-sandbox` 로 우회합니다.

## 라이선스

Apache-2.0. 설치 파일에 함께 들어가는 서드파티 구성 요소와, **동봉하지 않고 사용자가 직접
가져오는 것**(Live2D Cubism Core · Spine 런타임)의 근거는
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 를 보세요.

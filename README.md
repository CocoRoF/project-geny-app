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
| **도구** | 31종 — 파일 · 셸 · 웹 · 백그라운드 · 예약 · 위임 · MCP, 그리고 **이 앱만 하는 것**(화면 캡처 · 알림 · 클립보드). 에이전트별 on/off |
| **격리** | 에이전트마다 자기 워크스페이스. 도구는 그 밖으로 나갈 수 없습니다 |
| **권한** | 신중 / 표준 / 신뢰 — 위험한 작업은 앱에서 승인 |
| **대화 영속** | 앱을 껐다 켜도 대화와 **엔진 컨텍스트**가 이어집니다 |
| **MCP** | 서버 등록 → 에이전트별 on/off. *실제로 연결됐는지* 엔진에 물어 보여줍니다 |
| **스킬 · 명령어** | `<데이터>/skills`, `<데이터>/commands` 에 넣으면 자동 인식 |
| **파일** | workspace · artifacts · memory 탐색, 텍스트/이미지 미리보기 |
| **백그라운드** | Task(파일 영속) · Cron(러너가 실제로 발화) — 예약이 있는 세션은 정리하지 않습니다 |
| **위임** | 서브에이전트에 일을 맡기고 그 활동을 대화에 표시 (worker · researcher · summarizer · critic) |
| **퀵챗** | `Ctrl/Cmd+Shift+G` — 다른 앱 위에 떠서 바로 묻고 답을 받습니다. 트레이 상주 |
| **브라우저** | 에이전트가 실제 브라우저 창을 조작합니다 — 열기 · 요소 스냅샷 · 클릭/입력 · 본문 읽기 |

제거된 것: GAPT(샌드박스) · 클라우드/동기화 · 오디오 자체 서빙 · 로그인/관리자.

## 설치

[Releases](https://github.com/CocoRoF/project-geny-app/releases/latest) 에서 받으세요.

| OS | 파일 | 첫 실행 |
|---|---|---|
| **Windows** | `Geny-Setup-*.exe` | SmartScreen → **추가 정보 → 실행** (현재 무서명) |
| **macOS** | `Geny-*.dmg` | Applications 로 드래그 → **우클릭 → 열기** (Gatekeeper, 무서명) |
| **Linux** | `Geny-*.AppImage` | `chmod +x` 후 실행 · 또는 `.deb` |

파이썬도 API 서버도 따로 설치할 필요가 없습니다 — 엔진이 설치 파일에 들어 있습니다.
첫 실행에서 **Anthropic API 키**를 넣거나, `claude` CLI 가 이미 있으면 그대로 씁니다.

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
| `node scripts/verify-bundle.mjs` | 동봉 파이썬이 실제로 돌고 프로토콜을 말하는지 |

Linux 개발 실행에서 `chrome-sandbox` SUID 가 없으면 SIGTRAP — `--no-sandbox` 로 우회합니다.

## 라이선스

Apache-2.0

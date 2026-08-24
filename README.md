<h1 align="center">project-geny-app</h1>

<p align="center"><em>Geny를, 서버 없이, 앱 하나로.</em></p>

<p align="center">
다운로드 → 실행. Docker 없음 · 서버 없음 · Python 수동 설치 없음.<br/>
Anthropic · OpenAI · Claude Code CLI 를 한 앱에서.
</p>

---

## 무엇인가

[Geny](https://github.com/CocoRoF/Geny)는 5개 컨테이너와 Postgres를 띄우는 멀티유저 플랫폼입니다.
이 프로젝트는 그 **기능 전부를 1인 사용자용 데스크톱 앱 하나**로 재구성합니다.

- **에이전트** — 21단계 파이프라인, 내장 도구 36종, MCP, 스킬, 슬래시 커맨드, 서브에이전트 위임
- **에이전트별 워크스페이스** — 앱 데이터 폴더 아래에 각자의 `workspace/`, `memory/`, `artifacts/`
- **메모리** — API 호출 0회, SQLite 파일 기반 (임베딩 서버 불필요)
- **권한** — 위험한 작업은 앱에서 승인 프롬프트로 round-trip
- **제거된 것** — GAPT(샌드박스), 클라우드/동기화, 오디오 자체 서빙, 로그인/관리자

## 구조

```
Electron main ──JSON-lines stdio──> Python 사이드카 (geny-executor)
  윈도우·SQLite·시크릿·IPC              21 stages · 도구 · MCP · 메모리
      │
      └─> renderer (React 19 · Zustand)
```

엔진은 Python(`geny-executor`)을 그대로 씁니다 — 앱은 그 위의 *서버 계층*을 대체합니다.
자세한 결정 근거와 기각된 대안은 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**네이티브 모듈 0개** — 저장소는 Node 내장 `node:sqlite`.

## 개발

```bash
npm install
npm run engine:venv     # engine/.venv 에 파이썬 엔진 설치 (uv 필요)
npm run engine:smoke    # 사이드카 프로토콜 검증 (API 키 불필요)
npm run dev             # 앱 실행
```

검증 스크립트:

| 명령 | 무엇을 보장하나 |
|---|---|
| `npm run engine:smoke` | 사이드카 프로토콜: ready → ping → turn → 종결 이벤트 정확히 1개 → 정상 종료 |
| `npm test` | SDK 핀 계약 (anthropic 0.12x / openai 3.x, 제거된 의존성 부재) |
| `node test/launch-check.mjs` | 실제 앱 실행: 윈도우 → preload → 엔진 ready → 에이전트 생성 → 턴 스트리밍 |

Linux에서 개발 실행 시 `chrome-sandbox` SUID가 없으면 SIGTRAP — `--no-sandbox`로 우회하고,
패키징에서는 postinst가 `4755`를 강제합니다.

## 상태

M0(걷는 해골) 통과 — 앱이 뜨고, 엔진이 붙고, 턴이 스트리밍됩니다.
로드맵은 [`docs/ARCHITECTURE.md` §4](docs/ARCHITECTURE.md).

## 라이선스

Apache-2.0

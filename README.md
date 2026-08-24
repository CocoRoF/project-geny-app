# project-geny-app

**Geny, as one desktop app.** Agents with real tools, memory, MCP and skills —
running entirely on your machine. No server, no Docker, no accounts.

> 상태: **M0/M1 통과** (걷는 해골 + 실제 도구 실행). 로드맵은
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4.

## 무엇이 다른가

| | Geny | 이 앱 |
|---|---|---|
| 실행 | docker compose 5개 + nginx | 설치 파일 하나 |
| 사용자 | 멀티유저 + 로그인 | 1인, 로그인 없음 |
| 백엔드 | FastAPI 서버 | 앱이 전부 소유 |
| 저장소 | PostgreSQL + qdrant | SQLite 1파일 |
| LLM | 5 provider | Anthropic · OpenAI · Claude Code CLI |

## 개발 실행

```bash
npm install
npm run engine:venv     # 엔진용 파이썬 환경 (uv 필요, 1회)
npm run engine:smoke    # 사이드카 프로토콜 검증 — API 키 불필요
npm run dev             # 앱 실행
```

수락 테스트 (실제 앱을 띄워 도구까지 검증, Claude Code CLI 인증만 필요):

```bash
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node test/m0-e2e.mjs
```

## 구조

```
src/main/       Electron main — 데이터루트·SQLite·시크릿·사이드카 감독·IPC
src/preload/    window.geny — 유일한 브릿지
src/renderer/   React UI (VS-Code 형태 단일 윈도우)
src/shared/     프로세스 간 유일한 계약 (프로토콜·API 타입)
engine/geny_app 파이썬 호스트 계층 — geny-executor 상주 데몬
docs/           아키텍처·결정 기록
```

## 설계에서 이미 실증된 것

- geny-executor는 **서버 없이 단독 구동**된다 (SQLite·파일 메모리, 서버 0개)
- 사이드카 프로토콜: 상주 데몬 + JSON-lines, 턴당 종결 이벤트 정확히 1개
- **네이티브 모듈 0개** — Electron 43 내장 `node:sqlite` 사용 (node-gyp·리빌드 없음)
- 의존성 트리 181MB → **94MB** (numpy·psycopg·pgvector·google-genai 제거)
- LLM SDK 메이저는 **고정**해야 한다 (anthropic 1.0.0은 엔진을 깨뜨림 — 계약 테스트로 잠금)

## 라이선스

Apache-2.0

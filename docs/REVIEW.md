# 전면 검토 — "Geny + Geny-connector 를 앱 하나로, 동일 수준" 기준

검토일 2026-08-24 · 대상 `686f296` (v0.1.0 릴리스 시점)
판정 방식: **주장을 읽지 않고 실행해서 확인**. 모든 항목에 재현 명령이 붙는다.

---

## 요약

| | |
|---|---|
| 뼈대 | **건강함.** 사이드카·영속·격리·패키징은 실제로 동작하고 테스트가 지킨다 |
| Geny 대비 | 엔진이 가진 힘의 **약 30%만 노출**. 도구 36종 중 10종 |
| connector 대비 | 데스크톱 기능은 **사실상 0** (아바타·음성·오버레이·자동화·핫키) |
| 가장 위험한 것 | **조용한 실패 3건** — 되는 것처럼 보이고 안 되는 기능 |

동일 수준까지의 거리는 "구조를 다시 짜야 함"이 아니라 **"배선하지 않은 것을 배선함"** 이다.
단 하나, connector 급 기능만은 **프로토콜에 없는 방향**이 필요하다(§4).

---

## 1. P0 — 주장과 실제가 다름 (조용한 실패)

되지 않는데 **되는 것처럼 보이는** 것이 가장 나쁘다. 세 건 모두 이 부류다.

### 1.1 Cron: 저장되고 영원히 발화되지 않는다
`host.py` 는 `cron_store` 를 주입하지만 `cron_runner` 는 주입하지 않는다.
엔진의 `cron_tools._refresh()` 는 러너가 없으면 **조용히 통과**한다:

```python
runner = context.extras.get("cron_runner")     # None
refresh = getattr(runner, "refresh", None) if runner else None
if callable(refresh): ...                       # 그냥 건너뜀
```

→ `CronCreate` 는 성공을 보고하고, 잡은 `jobs.json` 에 남고, 아무 일도 일어나지 않는다.
게다가 Cron\* 도구는 애초에 켜져 있지도 않다(§2). README 의 "백그라운드 Task · Cron" 은
현재 사실이 아니다.

**고치는 법**: `CronRunner` 를 사이드카 이벤트 루프에 띄우고 extras 에 넣는다
(엔진이 `geny_executor/cron/runner.py` 로 제공). 러너 없이 `cron_store` 만 주입하는
조합은 **금지**해야 한다 — 실패가 보이지 않는 유일한 조합이다.

### 1.2 위임(subagent): 그릴 준비만 되어 있고 발생할 수 없다
`sidecar.py` 는 `agent.orchestrate_start` 등을 UI 이벤트로 승격하고 스토어에
`delegations` 배열이 있다. 그러나

- `Agent` / `SubAgent*` 도구가 **활성 목록에 없고**
- `agent_orchestrator` · `subagent_manager` · `subagent_credentials` · `agent_depth`
  가 **extras 에 주입되지 않는다**

→ 그 이벤트는 영원히 오지 않는다. README 의 "위임 — 서브에이전트 활동을 대화에 표시" 는
표시 코드만 있는 상태다.

### 1.3 "도구 36종" — 실측 10종
실행 중인 앱에 직접 물어본 결과:

```
TOOLS(10): AskUserQuestion Bash Edit Glob Grep Read TodoWrite WebFetch WebSearch Write
```

엔진이 **가진** 것이 36종이고, 앱이 **켜는** 것은 10종이다. README 표현을 고치거나
(§2 처럼) 실제로 켜야 한다.

---

## 2. P1 — Geny 대비 공백

### 2.1 켜지지 않은 도구 26종
`session.py: DEFAULT_TOOLS` 가 10종으로 고정돼 있고 `TurnConfig` 는 `builtInTools` 를
보내지 않는다. 빠진 것 중 **호스트 배선만 하면 즉시 되는 것**:

| 도구 | 필요한 extras | 엔진이 구현체를 주는가 |
|---|---|---|
| `Task*` | `task_registry` `task_runner` | ✅ 이미 주입돼 있음 (도구만 켜면 됨) |
| `Cron*` | `cron_store` `cron_runner` | ⚠ store 만 주입 — §1.1 |
| `Agent` `SubAgent*` | `agent_orchestrator` `subagent_manager` … | 호스트가 구현해야 함 |
| `SendUserFile` | `user_file_channel` | ABC 제공 — 렌더러로 파일 전달 구현 |
| `PushNotification` | `notification_endpoints` | ✅ 레지스트리 제공 |
| `SendMessage` | `send_message_channels` | ✅ webhook/telegram/discord/slack/ntfy 내장 |
| `Monitor` `Config` | `event_bus` `pipeline` `pipeline_mutator` | ✅ 파이프라인 자체 |
| `ListMcpResources` 외 | `mcp_manager` | ✅ 파이프라인이 보유 |
| `Doc*` `Browser*` | 선택 패키지 | feature pack 설치 후 자동 |
| `Ssh*` `Google*` `Atlassian*` | 자격증명 bag | 설정 UI 필요 |

### 2.2 Geny 에 있고 앱에 없는 상위 개념
페르소나 · 환경(21-stage) 빌더 · 훅/자동화 · 도구 정책/프리셋 · 자기제작 도구(forged) ·
지식/RAG(curated knowledge) · Opsidian 메모리 브라우저 · 화이트보드 ·
게이트웨이(Discord/Telegram/Slack) · 트리거 프리셋.

이 중 **메모리는 실제로 동작**한다(파일 provider 를 manifest 에 주입) — 브라우저 UI 만 없다.

---

## 3. P1 — connector 대비 공백 (현재 0)

`grep` 으로 전수 확인한 결과 아래는 **코드가 존재하지 않는다**:

아바타 오버레이(Live2D/Spine/MMD) · 칩 창 · 퀵챗 핫키 · 음성(STT/TTS·핸즈프리) ·
데스크톱 자동화(`browser_*` CDP · `app_*` UIA · `office_*` COM) · 화면 캡처 ·
전역 단축키 · 데스크톱 알림.

Geny 사용자가 "지니"라고 부를 때 떠올리는 것의 상당 부분이 여기 있다. 기능 목록이 아니라
**제품 정체성**이므로 우선순위가 낮지 않다.

---

## 4. 아키텍처 격차 — 엔진이 앱을 호출할 길이 없다 ★

지금 프로토콜의 양방향 경로는 `prompt`(질문)와 `hitl`(승인) **둘뿐**이다.
엔진(Python)이 Electron 의 능력을 쓰는 길이 없다. 그래서 §3 의 기능들은
"만들면 되는 것"이 아니라 **현재 구조에서는 만들 수 없다**.

**필요한 것**: 프로토콜에 호스트 도구 방향을 추가한다.

```
engine → app   {id, type:'host_tool_call', callId, name, args}
app   → engine {id, op:'host_tool_result', callId, ok, result|error}
```

사이드카는 이 이름들을 adhoc 도구로 등록해 엔진 도구 레지스트리에 넣는다
(`tools/adhoc.py` 가 이미 그 자리다). 그러면 아래가 전부 **에이전트 도구**가 된다:

화면 캡처 · 브라우저 제어 · 데스크톱 자동화 · 알림 · 아바타 표정/모션 · 창 제어 ·
파일 대화상자 · 클립보드 · 시스템 지표.

이 하나가 "앱이 전부 소유한다"를 말이 되게 만드는 유일한 조각이다. **다음 작업 1순위.**

---

## 5. P2 — UX

`capabilities.inspect` 는 파이프라인이 **첫 턴에 지연 생성**되므로 그 전에는 `tools: []`
를 돌려준다. 실측:

```
BEFORE turn — tools: 0
TOOLS(10): AskUserQuestion Bash Edit ...
```

사용자에게는 "도구 없음"으로 보인다. 검사 시 파이프라인을 워밍업하거나, UI 가
"첫 대화 후 확인 가능"을 명시해야 한다.

---

## 6. 건강한 것 (회귀시키지 말 것)

실행으로 확인했다.

- 사이드카 프로토콜: ready → ping → turn → 종결 이벤트 정확히 1개 → 정상 종료
- 앱 기동 게이트 8항목 전부 통과 (온보딩·엔진·에이전트·**워크스페이스 탈출 거부**·MCP)
- 타입체크 클린, 단위 6종 통과 (SDK 핀·제거 의존성 부재·TurnConfig 완전성)
- 네이티브 모듈 0개 (`node:sqlite`)
- 대화·엔진 컨텍스트 영속 (엔진의 `FileSessionPersistence`)
- 어댑티브 라우터를 끄고 사용자의 모델 선택을 그대로 쓰는 결정 — CLI 가 모르는 모델로
  바꿔치기해 **행(hang)** 을 만드는 문제를 막는다

---

## 7. 권장 순서

1. **호스트 도구 브릿지**(§4) — 이것이 열려야 connector 급 기능이 가능해진다
2. **조용한 실패 3건 제거**(§1) — cron runner 주입, 위임 배선 또는 UI 제거, README 정정
3. **도구 노출 확대**(§2.1) — 배선만으로 되는 것부터: Task·Cron·SendMessage·PushNotification·Monitor
4. **에이전트별 도구 on/off UI** — 36종을 켤 수 있게 되면 필수
5. connector 기능 이식 — 아바타 → 퀵챗/핫키 → 음성 → 데스크톱 자동화
6. Geny 상위 개념 — 페르소나 → 환경 빌더 → 훅 → 지식/RAG

---

## 재현

```bash
npm test && node test/app-launch.mjs           # §6
node scratch/cap-probe.mjs                      # §1.3 §5 (도구 실측)
grep -n cron_runner engine/geny_app/host.py     # §1.1 (없음)
grep -rn agent_orchestrator engine/geny_app/    # §1.2 (없음)
```

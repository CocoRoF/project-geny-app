/**
 * The tools an agent can be given, grouped for a human.
 *
 * Names must exist in the engine (test/tool-names.test.ts enforces it) and
 * every entry must have its host service wired in engine/geny_app/host.py —
 * a tool without its service answers with an error the user cannot act on.
 */
export interface ToolGroup {
  id: string;
  label: string;
  hint: string;
  tools: Array<{ name: string; label: string; risky?: boolean }>;
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'files',
    label: '파일',
    hint: '에이전트 워크스페이스 안에서만 동작합니다',
    tools: [
      { name: 'Read', label: '읽기' },
      { name: 'Write', label: '쓰기' },
      { name: 'Edit', label: '수정' },
      { name: 'Glob', label: '경로 검색' },
      { name: 'Grep', label: '내용 검색' },
      { name: 'NotebookEdit', label: '노트북 편집' },
    ],
  },
  {
    id: 'shell',
    label: '셸',
    hint: '명령을 실행합니다. 권한 태도에 따라 승인을 물을 수 있습니다',
    tools: [{ name: 'Bash', label: '명령 실행', risky: true }],
  },
  {
    id: 'web',
    label: '웹',
    hint: '검색과 페이지 읽기',
    tools: [
      { name: 'WebSearch', label: '검색' },
      { name: 'WebFetch', label: '페이지 읽기' },
    ],
  },
  {
    id: 'planning',
    label: '계획',
    hint: '할 일 목록과 계획 모드',
    tools: [
      { name: 'TodoWrite', label: '할 일' },
      { name: 'ExitPlanMode', label: '계획 종료' },
    ],
  },
  {
    id: 'ask',
    label: '질문',
    hint: '작업 중 사용자에게 되묻습니다',
    tools: [{ name: 'AskUserQuestion', label: '사용자에게 질문' }],
  },
  {
    id: 'background',
    label: '백그라운드',
    hint: '오래 걸리는 일을 맡겨두고 결과를 나중에 받습니다',
    tools: [
      { name: 'TaskCreate', label: '작업 생성' },
      { name: 'TaskList', label: '작업 목록' },
      { name: 'TaskGet', label: '작업 조회' },
      { name: 'TaskOutput', label: '작업 출력' },
      { name: 'TaskUpdate', label: '작업 갱신' },
      { name: 'TaskStop', label: '작업 중지' },
    ],
  },
  {
    id: 'schedule',
    label: '예약',
    hint: '앱이 켜져 있는 동안 정해진 시각에 실행합니다',
    tools: [
      { name: 'CronCreate', label: '예약 생성' },
      { name: 'CronList', label: '예약 목록' },
      { name: 'CronDelete', label: '예약 삭제' },
    ],
  },
  {
    id: 'delegation',
    label: '위임',
    hint: '하위 에이전트에게 일을 나눠 맡깁니다',
    tools: [{ name: 'Agent', label: '서브에이전트 위임' }],
  },
  {
    id: 'mcp',
    label: 'MCP',
    hint: '등록한 MCP 서버의 리소스',
    tools: [
      { name: 'ListMcpResources', label: '리소스 목록' },
      { name: 'ReadMcpResource', label: '리소스 읽기' },
    ],
  },
  {
    id: 'discovery',
    label: '탐색',
    hint: '숨어 있는 도구를 모델이 찾습니다',
    tools: [{ name: 'ToolSearch', label: '도구 검색' }],
  },
  {
    id: 'desktop',
    label: '데스크톱',
    hint: '이 앱만 할 수 있는 것 — 화면·알림·클립보드',
    tools: [
      { name: 'ScreenCapture', label: '화면 캡처', risky: true },
      { name: 'Notify', label: '알림' },
      { name: 'Say', label: '진행 상황 알리기' },
      { name: 'Clipboard', label: '클립보드', risky: true },
      { name: 'OpenPath', label: '결과 열기' },
      { name: 'ReadUserFile', label: '외부 파일 읽기', risky: true },
    ],
  },
  {
    id: 'browser',
    label: '브라우저',
    hint: '앱이 띄운 실제 브라우저 창을 에이전트가 조작합니다 — 보고 있을 수 있습니다',
    tools: [
      { name: 'BrowserOpen', label: '열기' },
      { name: 'BrowserSnapshot', label: '요소 보기' },
      { name: 'BrowserAct', label: '클릭·입력', risky: true },
      { name: 'BrowserRead', label: '본문 읽기' },
      { name: 'BrowserBack', label: '뒤로' },
      { name: 'BrowserClose', label: '닫기' },
    ],
  },
];

/** Names the desktop side implements — they are not engine built-ins. */
export const HOST_TOOL_NAMES = new Set(
  TOOL_GROUPS.filter((g) => g.id === 'desktop' || g.id === 'browser').flatMap((g) =>
    g.tools.map((t) => t.name),
  ),
);

export const ALL_TOOL_NAMES = TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));

/** Engine built-ins only — host tools are added separately by the app. */
export const DEFAULT_ENABLED = ALL_TOOL_NAMES.filter((n) => !HOST_TOOL_NAMES.has(n));

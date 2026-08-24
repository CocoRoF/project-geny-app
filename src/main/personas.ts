/**
 * Personas — a reusable bundle of "who this agent is".
 *
 * Geny had persona presets as a server-side registry. Here a persona is just
 * a markdown file with frontmatter in `<data-root>/personas`, for the same
 * reason skills and commands are directories: the user can read, edit, copy
 * and share them without the app inventing a format they cannot inspect.
 *
 *   ---
 *   name: 조사원
 *   description: 웹을 뒤져 근거를 모아옵니다
 *   posture: standard
 *   tools: [Read, Write, WebSearch, WebFetch, BrowserOpen, BrowserRead]
 *   ---
 *   You research thoroughly and cite sources...
 *
 * Everything except the body is optional: a persona that only sets a prompt
 * is a perfectly good persona.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPosture } from '@shared/sidecar-protocol';

export interface Persona {
  id: string;
  name: string;
  description?: string;
  model?: string;
  posture?: AgentPosture;
  tools?: string[];
  prompt: string;
  /** false for the starters the app writes on first run */
  userDefined: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A deliberately small parser: enough for scalars and inline lists, and it
 *  never throws — a malformed persona degrades to "prompt only". */
export function parsePersona(id: string, raw: string, userDefined = true): Persona {
  const match = FRONTMATTER.exec(raw);
  const body = match ? raw.slice(match[0].length) : raw;
  const meta: Record<string, string> = {};
  if (match?.[1]) {
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  const list = (value: string | undefined): string[] | undefined => {
    if (!value) return undefined;
    const inner = value.replace(/^\[|\]$/g, '');
    const items = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    return items.length ? items : undefined;
  };
  const posture = meta.posture as AgentPosture | undefined;
  return {
    id,
    name: meta.name || id,
    description: meta.description || undefined,
    model: meta.model || undefined,
    posture: posture === 'careful' || posture === 'standard' || posture === 'trusted' ? posture : undefined,
    tools: list(meta.tools),
    prompt: body.trim(),
    userDefined,
  };
}

export function serializePersona(persona: Omit<Persona, 'id' | 'userDefined'>): string {
  const lines = ['---', `name: ${persona.name}`];
  if (persona.description) lines.push(`description: ${persona.description}`);
  if (persona.model) lines.push(`model: ${persona.model}`);
  if (persona.posture) lines.push(`posture: ${persona.posture}`);
  if (persona.tools?.length) lines.push(`tools: [${persona.tools.join(', ')}]`);
  lines.push('---', '', persona.prompt.trim(), '');
  return lines.join('\n');
}

/** Starters, written once so the folder is never empty and the format is
 *  self-documenting. Not overwritten afterwards — they are the user's now. */
const STARTERS: Array<Omit<Persona, 'id' | 'userDefined'>> = [
  {
    name: '조사원',
    description: '웹을 뒤져 근거와 출처를 모아옵니다',
    posture: 'standard',
    tools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'BrowserOpen', 'BrowserSnapshot', 'BrowserAct', 'BrowserRead', 'TodoWrite'],
    prompt: [
      '너는 조사를 맡는다. 주장에는 반드시 출처를 붙이고, 확인하지 못한 것은 확인하지 못했다고 말한다.',
      '',
      '- 검색으로 시작하되, 중요한 사실은 원문 페이지를 열어 직접 확인한다.',
      '- 찾은 내용은 워크스페이스에 정리해 남긴다.',
      '- 서로 어긋나는 자료를 만나면 양쪽을 모두 보여주고 무엇이 다른지 짚는다.',
    ].join('\n'),
  },
  {
    name: '작업자',
    description: '파일과 명령으로 실제 일을 처리합니다',
    posture: 'standard',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'TaskCreate', 'TaskList', 'TaskOutput'],
    prompt: [
      '너는 요청받은 작업을 워크스페이스 안에서 직접 수행한다.',
      '',
      '- 길어질 일은 먼저 할 일 목록으로 쪼갠다.',
      '- 파괴적인 명령은 실행 전에 무엇을 왜 하는지 한 줄로 알린다.',
      '- 끝나면 무엇을 바꿨는지 파일 단위로 보고한다.',
    ].join('\n'),
  },
  {
    name: '비서',
    description: '짧게 답하고, 알림과 예약을 챙깁니다',
    posture: 'careful',
    tools: ['Read', 'WebSearch', 'WebFetch', 'TodoWrite', 'CronCreate', 'CronList', 'CronDelete', 'Notify', 'Say'],
    prompt: [
      '너는 개인 비서다. 답은 짧게, 핵심부터.',
      '',
      '- 시간이 걸리는 일은 진행 상황을 알린다.',
      '- 반복되는 일은 예약을 제안한다.',
      '- 확실하지 않으면 추측하지 말고 되묻는다.',
    ].join('\n'),
  },
];

export function personaDir(dataRoot: string): string {
  const dir = join(dataRoot, 'personas');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureStarters(dataRoot: string): void {
  const dir = personaDir(dataRoot);
  const stamp = join(dir, '.starters');
  if (existsSync(stamp)) return; // written once; edits and deletions stick
  for (const starter of STARTERS) {
    const file = join(dir, `${starter.name}.md`);
    if (!existsSync(file)) writeFileSync(file, serializePersona(starter), 'utf8');
  }
  writeFileSync(stamp, new Date().toISOString(), 'utf8');
}

export function listPersonas(dataRoot: string): Persona[] {
  const dir = personaDir(dataRoot);
  const out: Persona[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const id = entry.name.replace(/\.md$/, '');
    try {
      out.push(parsePersona(id, readFileSync(join(dir, entry.name), 'utf8')));
    } catch {
      // an unreadable persona must not hide the rest
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function savePersona(
  dataRoot: string,
  persona: Omit<Persona, 'id' | 'userDefined'> & { id?: string },
): Persona {
  const id = (persona.id || persona.name || 'persona').replace(/[\\/:*?"<>|]/g, '-');
  writeFileSync(join(personaDir(dataRoot), `${id}.md`), serializePersona(persona), 'utf8');
  return { ...persona, id, userDefined: true };
}

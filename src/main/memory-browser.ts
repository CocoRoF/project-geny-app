/**
 * Reading what the agent remembers.
 *
 * The engine's file memory provider writes a Geny-compatible tree under the
 * agent's `memory/` directory:
 *
 *   memory/MEMORY.md              long-term memory, the durable summary
 *   memory/<category>/*.md        structured notes (daily, topics, projects,
 *                                 insights, conversations, compactions, …)
 *   transcripts/session.jsonl     short-term turn log
 *   transcripts/summary.md        rolling summary
 *
 * This module only READS. Memory is the agent's own record: an app that
 * silently rewrites it would make the transcript untrustworthy, so edits go
 * through the file manager (the folder is one click away) rather than a
 * half-hidden inline editor.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface MemoryNote {
  /** path relative to the agent's memory root — also its id */
  path: string;
  category: string;
  title: string;
  bytes: number;
  modified: number;
  preview: string;
}

export interface MemoryOverview {
  root: string;
  /** MEMORY.md — absent until the agent has written something durable */
  longTerm?: { path: string; bytes: number; modified: number; text: string };
  notes: MemoryNote[];
  categories: Array<{ id: string; count: number }>;
  transcript?: { path: string; turns: number; bytes: number };
}

const PREVIEW_CHARS = 200;
const MAX_NOTES = 500;

const firstHeading = (text: string, fallback: string): string => {
  for (const line of text.split(/\r?\n/, 40)) {
    const heading = /^#{1,3}\s+(.+)/.exec(line.trim());
    if (heading?.[1]) return heading[1].trim();
    // frontmatter title
    const titled = /^title:\s*(.+)$/i.exec(line.trim());
    if (titled?.[1]) return titled[1].trim().replace(/^["']|["']$/g, '');
  }
  return fallback;
};

const walk = (dir: string, root: string, out: MemoryNote[]): void => {
  if (out.length >= MAX_NOTES || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_NOTES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, out);
      continue;
    }
    if (!entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue;
    try {
      const stat = statSync(full);
      const text = readFileSync(full, 'utf8');
      const rel = relative(root, full);
      const [category = 'root'] = rel.split(/[\\/]/);
      out.push({
        path: rel,
        category: rel.includes('/') || rel.includes('\\') ? category : 'root',
        title: firstHeading(text, entry.name.replace(/\.md$/, '')),
        bytes: stat.size,
        modified: stat.mtimeMs,
        preview: text.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, PREVIEW_CHARS),
      });
    } catch {
      // a note we cannot read must not hide the rest
    }
  }
};

export function readMemory(agentDir: string): MemoryOverview {
  const root = join(agentDir, 'memory');
  const overview: MemoryOverview = { root, notes: [], categories: [] };
  if (!existsSync(root)) return overview;

  const longTermPath = join(root, 'memory', 'MEMORY.md');
  const legacyPath = join(root, 'MEMORY.md');
  const durable = existsSync(longTermPath) ? longTermPath : existsSync(legacyPath) ? legacyPath : null;
  if (durable) {
    try {
      const stat = statSync(durable);
      overview.longTerm = {
        path: durable,
        bytes: stat.size,
        modified: stat.mtimeMs,
        text: readFileSync(durable, 'utf8').slice(0, 20_000),
      };
    } catch {
      /* unreadable durable memory is reported as absent, not as a crash */
    }
  }

  // notes live under memory/memory/<category> in the engine's layout
  const notesRoot = existsSync(join(root, 'memory')) ? join(root, 'memory') : root;
  walk(notesRoot, notesRoot, overview.notes);
  overview.notes.sort((a, b) => b.modified - a.modified);

  const counts = new Map<string, number>();
  for (const note of overview.notes) counts.set(note.category, (counts.get(note.category) ?? 0) + 1);
  overview.categories = [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);

  const jsonl = join(root, 'transcripts', 'session.jsonl');
  if (existsSync(jsonl)) {
    try {
      const stat = statSync(jsonl);
      const turns = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim()).length;
      overview.transcript = { path: jsonl, turns, bytes: stat.size };
    } catch {
      /* ignore */
    }
  }
  return overview;
}

export interface TranscriptTurn {
  index: number;
  role: string;
  text: string;
  at?: number;
}

/**
 * The short-term turn log.
 *
 * Structured notes and MEMORY.md only appear once the engine reflects or
 * compacts, which needs a longer session — but the transcript exists from
 * the first turn, and "what do you remember about our conversation" is
 * exactly what a user asks first. Showing only a turn count while the
 * content sits unread on disk would be a worse answer than none.
 */
export function readTranscript(agentDir: string, limit = 200): TranscriptTurn[] {
  const file = join(agentDir, 'memory', 'transcripts', 'session.jsonl');
  if (!existsSync(file)) return [];
  const out: TranscriptTurn[] = [];
  let index = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    index += 1;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const content = row.content ?? row.text ?? row.message ?? '';
      out.push({
        index,
        role: String(row.role ?? row.type ?? 'turn'),
        text: typeof content === 'string' ? content : JSON.stringify(content),
        at: typeof row.ts === 'number' ? row.ts : undefined,
      });
    } catch {
      // one unparsable line must not hide the rest of the conversation
      out.push({ index, role: 'raw', text: line.slice(0, 500) });
    }
  }
  return out.slice(-limit);
}

/** Full text of one note, addressed by the path `readMemory` returned. */
export function readMemoryNote(agentDir: string, notePath: string): { path: string; text: string } {
  const root = join(agentDir, 'memory');
  const notesRoot = existsSync(join(root, 'memory')) ? join(root, 'memory') : root;
  const full = join(notesRoot, notePath);
  // the browser addresses notes by the relative paths it was given; refuse
  // anything that climbs out, the same rule the file tab follows
  if (!full.startsWith(notesRoot)) throw new Error('outside the memory directory');
  return { path: full, text: readFileSync(full, 'utf8').slice(0, 200_000) };
}

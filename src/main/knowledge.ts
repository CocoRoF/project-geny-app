/**
 * Knowledge — the user's own documents, searchable by the agent.
 *
 * Design constraints that decided the shape:
 *  · no API calls. Embedding every document would cost money per file and
 *    per query, and stop working offline. Geny's own answer was a local
 *    zero-API index for the same reason.
 *  · no new dependencies. `node:sqlite` ships FTS5, so the index is one
 *    file next to the app's database and needs no native module.
 *  · documents stay files. `<data-root>/knowledge` is a folder the user
 *    fills; the index is derived and can be rebuilt at any time.
 *
 * The Korean problem, measured rather than assumed: FTS5's `trigram`
 * tokenizer only matches queries of THREE characters or more, and two-syllable
 * Korean words ("가격", "결정", "배포") are the common case. `unicode61` is
 * worse — it splits on spaces, so "가격은" never matches "가격" at all.
 * So: trigram FTS for ≥3 characters, plain substring for shorter queries,
 * merged. Slower for the short case, but it finds things.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface KnowledgeHit {
  path: string;
  title: string;
  snippet: string;
  modified: number;
}

export interface IndexReport {
  documents: number;
  chunks: number;
  skipped: Array<{ path: string; reason: string }>;
  took: number;
}

/** Extensions worth indexing as text. Binary formats need a converter and
 *  are reported as skipped rather than indexed as mojibake. */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.org',
  '.json', '.yaml', '.yml', '.toml', '.csv',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.sh', '.sql',
  '.html', '.css',
]);

const MAX_FILE_BYTES = 2_000_000;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const TRIGRAM_MIN = 3;

export function knowledgeDir(dataRoot: string): string {
  const dir = join(dataRoot, 'knowledge');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Split on blank lines first so a chunk is usually a whole thought, then
 *  hard-wrap anything still oversized. */
function chunk(text: string): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    if (buffer.length + paragraph.length + 2 <= CHUNK_CHARS) {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (buffer) out.push(buffer);
    if (paragraph.length <= CHUNK_CHARS) {
      buffer = paragraph;
      continue;
    }
    for (let at = 0; at < paragraph.length; at += CHUNK_CHARS - CHUNK_OVERLAP) {
      out.push(paragraph.slice(at, at + CHUNK_CHARS));
    }
    buffer = '';
  }
  if (buffer) out.push(buffer);
  return out.filter((c) => c.trim().length > 0);
}

export class KnowledgeStore {
  private db: DatabaseSync;

  constructor(
    private readonly dataRoot: string,
    dbFile = join(dataRoot, 'knowledge.db'),
  ) {
    knowledgeDir(dataRoot);
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        modified INTEGER NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        path UNINDEXED, title, body, tokenize='trigram'
      );
    `);
  }

  /** Rebuild from the folder. Cheap enough to run on demand: the index is
   *  derived data, so a corrupted or stale one is never a real problem. */
  reindex(): IndexReport {
    const started = Date.now();
    const root = knowledgeDir(this.dataRoot);
    const skipped: IndexReport['skipped'] = [];
    let documents = 0;
    let chunks = 0;

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM chunks');
      this.db.exec('DELETE FROM documents');
      const insertDoc = this.db.prepare(
        'INSERT OR REPLACE INTO documents (path,title,modified,bytes) VALUES (?,?,?,?)',
      );
      const insertChunk = this.db.prepare(
        'INSERT INTO chunks (path,title,body) VALUES (?,?,?)',
      );

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.')) continue;
            walk(full);
            continue;
          }
          const rel = relative(root, full);
          const ext = extname(entry.name).toLowerCase();
          if (!TEXT_EXT.has(ext)) {
            skipped.push({ path: rel, reason: `unsupported type ${ext || '(none)'}` });
            continue;
          }
          const stat = statSync(full);
          if (stat.size > MAX_FILE_BYTES) {
            skipped.push({ path: rel, reason: `too large (${Math.round(stat.size / 1024)}KB)` });
            continue;
          }
          let text: string;
          try {
            text = readFileSync(full, 'utf8');
          } catch (err) {
            skipped.push({ path: rel, reason: err instanceof Error ? err.message : 'unreadable' });
            continue;
          }
          const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name;
          insertDoc.run(rel, title, stat.mtimeMs, stat.size);
          documents += 1;
          for (const piece of chunk(text)) {
            insertChunk.run(rel, title, piece);
            chunks += 1;
          }
        }
      };
      if (existsSync(root)) walk(root);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { documents, chunks, skipped, took: Date.now() - started };
  }

  search(query: string, limit = 6): KnowledgeHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const modified = new Map(
      (this.db.prepare('SELECT path, modified FROM documents').all() as Array<{
        path: string;
        modified: number;
      }>).map((r) => [r.path, r.modified]),
    );
    const hits = new Map<string, KnowledgeHit>();

    // FTS handles anything trigram can tokenize
    const terms = trimmed.split(/\s+/).filter((t) => [...t].length >= TRIGRAM_MIN);
    if (terms.length > 0) {
      const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      try {
        const rows = this.db
          .prepare(
            `SELECT path, title, snippet(chunks, 2, '«', '»', '…', 20) AS snippet
             FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(match, limit) as Array<{ path: string; title: string; snippet: string }>;
        for (const row of rows) {
          if (!hits.has(row.path)) {
            hits.set(row.path, { ...row, modified: modified.get(row.path) ?? 0 });
          }
        }
      } catch {
        // a query FTS cannot parse falls through to the substring pass
      }
    }

    // Short queries — the two-syllable Korean case trigram cannot see
    if (hits.size < limit) {
      const rows = this.db
        .prepare(
          `SELECT path, title, body FROM chunks
           WHERE body LIKE '%' || ? || '%' OR title LIKE '%' || ? || '%' LIMIT ?`,
        )
        .all(trimmed, trimmed, limit) as Array<{ path: string; title: string; body: string }>;
      for (const row of rows) {
        if (hits.has(row.path) || hits.size >= limit) continue;
        const at = row.body.indexOf(trimmed);
        const from = Math.max(0, at - 60);
        hits.set(row.path, {
          path: row.path,
          title: row.title,
          snippet: `${from > 0 ? '…' : ''}${row.body.slice(from, at + trimmed.length + 60)}…`,
          modified: modified.get(row.path) ?? 0,
        });
      }
    }
    return [...hits.values()];
  }

  read(path: string): { path: string; text: string } {
    const root = knowledgeDir(this.dataRoot);
    const full = join(root, path);
    if (!full.startsWith(root)) throw new Error('outside the knowledge directory');
    return { path: full, text: readFileSync(full, 'utf8').slice(0, 200_000) };
  }

  stats(): { documents: number; chunks: number } {
    const documents = (this.db.prepare('SELECT count(*) c FROM documents').get() as { c: number }).c;
    const chunks = (this.db.prepare('SELECT count(*) c FROM chunks').get() as { c: number }).c;
    return { documents, chunks };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * SQLite via `node:sqlite` — Electron 43 ships it (verified: DatabaseSync,
 * StatementSync, backup, Session).
 *
 * Why not better-sqlite3: it is a native module, so it needs node-gyp, an
 * ABI rebuild per Electron version, and per-platform prebuilds in CI — and
 * 11.7 does not even compile against Electron 43's V8. Using the built-in
 * keeps this app at ZERO native modules, which is most of what makes
 * "download and run" true.
 *
 * Migrations are forward-only and inline: a solo project needs migrations
 * that are obvious in a diff, not a framework.
 */
import { DatabaseSync } from 'node:sqlite';
import type { AgentRecord, StoredMessage } from '@shared/api-types';
import type { AgentPosture } from '@shared/sidecar-protocol';

export type AgentPatch = Partial<Pick<AgentRecord, 'name' | 'model' | 'posture' | 'systemPrompt'>>;

export interface Store {
  raw: DatabaseSync;
  agents: {
    list(): AgentRecord[];
    get(id: string): AgentRecord | undefined;
    insert(a: AgentRecord): void;
    update(id: string, patch: AgentPatch): void;
    remove(id: string): void;
  };
  messages: {
    append(m: { agentId: string; role: string; text: string; meta?: unknown }): void;
    recent(agentId: string, limit?: number): StoredMessage[];
    clear(agentId: string): void;
  };
  settings: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  close(): void;
}

const MIGRATIONS: string[] = [
  // v1 — agents, messages, settings
  `CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT,
     dir TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     meta TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX messages_agent_idx ON messages(agent_id, id);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2 — permission posture and per-agent system prompt
  `ALTER TABLE agents ADD COLUMN posture TEXT NOT NULL DEFAULT 'standard';
   ALTER TABLE agents ADD COLUMN system_prompt TEXT;`,
];

const nullable = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

const toAgent = (r: Record<string, unknown>): AgentRecord => ({
  id: String(r.id),
  name: String(r.name),
  provider: r.provider as AgentRecord['provider'],
  model: nullable(r.model),
  posture: (nullable(r.posture) ?? 'standard') as AgentPosture,
  systemPrompt: nullable(r.system_prompt),
  dir: String(r.dir),
  createdAt: Number(r.created_at),
});

/** column per patch key — keeps the UPDATE builder from touching anything
 *  a caller did not name */
const AGENT_COLUMNS: Record<keyof AgentPatch, string> = {
  name: 'name',
  model: 'model',
  posture: 'posture',
  systemPrompt: 'system_prompt',
};

export function openStore(file: string): Store {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const version = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
  );
  for (let v = version; v < MIGRATIONS.length; v += 1) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const stmt = {
    insertAgent: db.prepare(
      'INSERT INTO agents (id,name,provider,model,dir,created_at,posture,system_prompt) VALUES (?,?,?,?,?,?,?,?)',
    ),
    listAgents: db.prepare('SELECT * FROM agents ORDER BY created_at DESC'),
    getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
    deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
    clearMessages: db.prepare('DELETE FROM messages WHERE agent_id = ?'),
    insertMessage: db.prepare('INSERT INTO messages (agent_id,role,text,meta,created_at) VALUES (?,?,?,?,?)'),
    recentMessages: db.prepare(
      'SELECT role,text,created_at AS createdAt FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?',
    ),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
  };

  return {
    raw: db,
    agents: {
      list: () => (stmt.listAgents.all() as Array<Record<string, unknown>>).map(toAgent),
      get: (id) => {
        const row = stmt.getAgent.get(id) as Record<string, unknown> | undefined;
        return row ? toAgent(row) : undefined;
      },
      insert: (a) => {
        stmt.insertAgent.run(
          a.id, a.name, a.provider, a.model ?? null, a.dir, a.createdAt,
          a.posture, a.systemPrompt ?? null,
        );
      },
      update: (id, patch) => {
        const sets: string[] = [];
        const values: Array<string | null> = [];
        for (const [key, column] of Object.entries(AGENT_COLUMNS)) {
          const value = patch[key as keyof AgentPatch];
          if (value === undefined) continue;
          sets.push(`${column} = ?`);
          values.push(value === null ? null : String(value));
        }
        if (sets.length === 0) return;
        db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      },
      remove: (id) => {
        stmt.deleteAgent.run(id);
      },
    },
    messages: {
      append: (m) => {
        stmt.insertMessage.run(m.agentId, m.role, m.text, m.meta ? JSON.stringify(m.meta) : null, Date.now());
      },
      recent: (agentId, limit = 200) =>
        (stmt.recentMessages.all(agentId, limit) as Array<Record<string, unknown>>)
          .map((r) => ({
            role: String(r.role) as StoredMessage['role'],
            text: String(r.text),
            createdAt: Number(r.createdAt),
          }))
          .reverse(),
      clear: (agentId) => {
        stmt.clearMessages.run(agentId);
      },
    },
    settings: {
      get: (key) => (stmt.getSetting.get(key) as { value: string } | undefined)?.value,
      set: (key, value) => {
        stmt.setSetting.run(key, value);
      },
    },
    close: () => db.close(),
  };
}

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
import type { AgentRecord } from '@shared/api-types';

export interface Store {
  raw: DatabaseSync;
  agents: {
    list(): AgentRecord[];
    get(id: string): AgentRecord | undefined;
    insert(a: AgentRecord): void;
    remove(id: string): void;
  };
  messages: {
    append(m: { agentId: string; role: string; text: string; meta?: unknown }): void;
    recent(agentId: string, limit?: number): Array<{ role: string; text: string; createdAt: number }>;
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
];

const toAgent = (r: Record<string, unknown>): AgentRecord => ({
  id: String(r.id),
  name: String(r.name),
  provider: r.provider as AgentRecord['provider'],
  model: r.model === null || r.model === undefined ? undefined : String(r.model),
  dir: String(r.dir),
  createdAt: Number(r.created_at),
});

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
    insertAgent: db.prepare('INSERT INTO agents (id,name,provider,model,dir,created_at) VALUES (?,?,?,?,?,?)'),
    listAgents: db.prepare('SELECT * FROM agents ORDER BY created_at DESC'),
    getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
    deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
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
        stmt.insertAgent.run(a.id, a.name, a.provider, a.model ?? null, a.dir, a.createdAt);
      },
      remove: (id) => {
        stmt.deleteAgent.run(id);
      },
    },
    messages: {
      append: (m) => {
        stmt.insertMessage.run(m.agentId, m.role, m.text, m.meta ? JSON.stringify(m.meta) : null, Date.now());
      },
      recent: (agentId, limit = 100) =>
        (stmt.recentMessages.all(agentId, limit) as Array<{ role: string; text: string; createdAt: number }>).reverse(),
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

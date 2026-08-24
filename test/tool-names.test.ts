/**
 * Every tool the app asks for must exist in the engine.
 *
 * A misspelled name does not fail — it is simply absent from the agent's
 * tool list, so the model never calls it and nobody finds out. Two names
 * ("TaskStatus", "TaskCancel") were wrong exactly this way; this test is why
 * they will not come back.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PY = process.platform === 'win32'
  ? join('engine', '.venv', 'Scripts', 'python.exe')
  : join('engine', '.venv', 'bin', 'python');

describe('tool catalogue', () => {
  it.skipIf(!existsSync(PY))('every requested built-in exists in the engine', () => {
    const out = execFileSync(
      PY,
      ['-c', `
import sys; sys.path.insert(0, 'engine')
from geny_app.session import DEFAULT_TOOLS
from geny_executor.tools.built_in import BUILT_IN_TOOL_CLASSES as C
known = set(C.keys())
print(','.join(t for t in DEFAULT_TOOLS if t not in known))`],
      { encoding: 'utf8' },
    ).trim();
    expect(out, 'these names silently vanish from the agent tool list').toBe('');
  });

  it.skipIf(!existsSync(PY))('every tool that needs a host service has one wired', () => {
    const out = execFileSync(
      PY,
      ['-c', `
import sys, tempfile; sys.path.insert(0, 'engine')
from geny_app.host import HostServices
class C:
    def __init__(s, d): s.agent_dir = d; s.extras = {}
class S:
    def __init__(s, d): s.session_id = 'probe'; s.config = C(d)
h = HostServices()
e = h.build_extras(S(tempfile.mkdtemp()), 't')
need = ['task_registry', 'task_runner', 'cron_store', 'cron_runner', 'agent_orchestrator']
missing = [k for k in need if e.get(k) is None]
print(','.join(missing + h.wiring_errors()))`],
      { encoding: 'utf8' },
    ).trim();
    expect(out, 'Task*/Cron*/Agent would answer with an error the user cannot act on').toBe('');
  });
});

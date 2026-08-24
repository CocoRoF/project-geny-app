/**
 * Where the user's hooks live, and the example that explains them.
 *
 * A hook is an external program the engine runs at points in the turn — it
 * can observe, and for tool events it can BLOCK. That is real power, so the
 * file is inert until the user sets `enabled: true`, and the app only sets
 * the engine's GENY_ALLOW_HOOKS opt-in when such a file exists.
 *
 * Per-agent hooks override the shared ones: a single agent that needs a gate
 * should not force it on every other agent.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXAMPLE = `# Geny hooks — external programs that watch (and can stop) an agent.
#
# Inert until you flip this to true.
enabled: false

# Events the engine actually fires today:
#   pipeline_start · pipeline_end · stage_enter · stage_exit
#   pre_tool_use · post_tool_use · post_tool_failure
#   permission_request · permission_denied · loop_iteration_end
#
# A hook receives the event as JSON on stdin and may answer on stdout.
# To STOP a tool call, answer with both fields the engine reads:
#   {"continue": false, "decision": "block", "stop_reason": "왜 막았는지"}
# ("deny" is not the word the engine looks for — it would run anyway.)
# To allow explicitly: {"decision": "approve"}. No output = observe only.

hooks:
  pre_tool_use:
    - command: /bin/echo
      args: ["hook saw a tool call"]
      timeout_ms: 3000
      match:
        tool: Bash        # only shell calls; drop 'match' to see every tool
`;

export function hooksPath(dataRoot: string): string {
  return join(dataRoot, 'hooks', 'hooks.yaml');
}

export function agentHooksPath(agentDir: string): string {
  return join(agentDir, 'hooks.yaml');
}

/** Written once so the feature is discoverable; never overwritten after. */
export function ensureHooksExample(dataRoot: string): void {
  const dir = join(dataRoot, 'hooks');
  mkdirSync(dir, { recursive: true });
  const file = hooksPath(dataRoot);
  if (!existsSync(file)) writeFileSync(file, EXAMPLE, 'utf8');
}

/** Per-agent file wins; otherwise the shared one; otherwise none. */
export function resolveHooksFile(dataRoot: string, agentDir: string): string | undefined {
  const perAgent = agentHooksPath(agentDir);
  if (existsSync(perAgent)) return perAgent;
  const shared = hooksPath(dataRoot);
  return existsSync(shared) ? shared : undefined;
}

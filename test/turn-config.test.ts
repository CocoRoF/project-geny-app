/**
 * Regression guard for TurnConfig completeness.
 *
 * This exists because the field list silently regressed: an edit rewrote
 * `turnConfig` and dropped posture, systemPrompt, timeout and MCP servers.
 * Everything still typechecked and every E2E still passed — the agent just
 * quietly lost its permission policy and its MCP servers. A missing field
 * here is invisible at runtime, so it gets asserted explicitly.
 */
import { describe, expect, it } from 'vitest';
import { EngineService } from '../src/main/engine-service';
import type { AgentRecord } from '../src/shared/api-types';

const agent: AgentRecord = {
  id: 'a1',
  name: 'test',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  posture: 'careful',
  systemPrompt: 'be terse',
  dir: '/tmp/agents/a1',
  createdAt: 0,
};

const service = new EngineService({
  cwd: '/tmp',
  locate: { installRoot: '/tmp/rt', bundleRoot: null, devVenvExe: null, cwd: '/tmp' },
  secret: () => 'sk-test',
  agentDir: (id) => `/tmp/agents/${id}`,
  mcpFor: () => [{ name: 'files', command: 'npx', args: ['-y', 'server'] }],
  hooksFile: () => undefined,
  skillDirs: () => ['/tmp/skills'],
  commandDirs: () => ['/tmp/commands'],
  emit: () => {},
  onStatus: () => {},
  persistAssistant: () => {},
});

describe('turnConfig', () => {
  const config = service.turnConfig(agent);

  it('carries every field the engine needs', () => {
    // each of these has a failure mode when absent, named in the comment
    expect(config.provider).toBe('anthropic');
    expect(config.model, 'absent model → engine default → CLI hangs').toBeTruthy();
    expect(config.apiKey, 'absent key → auth failure').toBe('sk-test');
    expect(config.agentDir, 'absent dir → tools run in the app source tree').toBeTruthy();
    expect(config.allowedPaths?.length, 'absent jail → tools reach the whole disk').toBeGreaterThan(0);
    expect(config.posture, 'absent posture → engine matrix allows on no-match').toBe('careful');
    expect(config.systemPrompt).toBe('be terse');
    expect(config.timeoutSeconds, 'absent timeout → a hung backend looks like a frozen app').toBeGreaterThan(0);
    expect(config.mcpServers?.length, 'absent servers → configured MCP silently does nothing').toBe(1);
    expect(config.skillDirs?.length, 'absent dirs → user skills never load').toBeGreaterThan(0);
    expect(config.commandDirs?.length).toBeGreaterThan(0);
  });

  it('jails tools to the agent workspace', () => {
    expect(config.allowedPaths?.[0]).toBe('/tmp/agents/a1/workspace');
  });

  it('falls back to a per-provider model when the agent has none', () => {
    const bare = service.turnConfig({ ...agent, model: undefined });
    expect(bare.model).toBeTruthy();
  });
});

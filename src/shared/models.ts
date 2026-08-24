/**
 * Per-backend model defaults and choices.
 *
 * This exists because of a real failure: the engine's default model id for
 * the CLI backend (`claude-sonnet-4-6`) does not exist in the installed
 * `claude` CLI, and the CLI does not reject an unknown model — it HANGS.
 * A turn then spins until the app's timeout with no diagnosis. So the app
 * states the model explicitly, and prefers ALIASES for the CLI (`sonnet`,
 * `opus`, `haiku`) which the CLI resolves to whatever is current, so they
 * cannot go stale the way a pinned id does.
 */
import type { TurnConfig } from './sidecar-protocol';

export type Provider = TurnConfig['provider'];

export interface ModelChoice {
  id: string;
  label: string;
  hint?: string;
}

export const MODELS: Record<Provider, ModelChoice[]> = {
  claude_code_cli: [
    { id: 'sonnet', label: 'Sonnet', hint: 'CLI가 현재 세대로 해석 — 권장' },
    { id: 'opus', label: 'Opus', hint: '가장 강력, 느리고 비쌈' },
    { id: 'haiku', label: 'Haiku', hint: '빠르고 저렴' },
  ],
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'o4-mini', label: 'o4-mini' },
  ],
};

export const defaultModel = (provider: Provider): string =>
  MODELS[provider][0]?.id ?? 'sonnet';

/** How long one turn may take before the app calls it dead. The engine's own
 *  CLI default is 300s; a hung CLI (see above) would otherwise look like a
 *  frozen app. */
export const TURN_TIMEOUT_SECONDS = 180;

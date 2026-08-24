/**
 * The app's Python dependency set — shared by the dev venv and the bundler
 * so they cannot drift.
 *
 * Pinned, not floated: geny-executor declares `anthropic>=0.52`, which
 * resolves to 1.0.0, whose `AsyncMessages.stream()` no longer accepts
 * `temperature` — every turn then dies with an opaque TypeError. These are
 * the versions Geny runs in production.
 *
 * Pruned: `numpy` is declared upstream but has ZERO call sites in the engine
 * (58 MB); `psycopg`/`pgvector` serve a Postgres memory provider this app
 * never selects; `google-genai` is a backend we do not ship. Installing the
 * closure explicitly instead of `geny-executor`'s own metadata drops ~90 MB.
 */
export const PY_SERIES = '3.12';

export const ENGINE_DEPS = [
  'geny-executor==2.65.4',
  'anthropic>=0.122,<1',
  'openai>=3.2,<4',
  'mcp>=1.0.0,<3',
  'pydantic>=2.0',
  'jsonschema>=4.0',
  'httpx>=0.27',
  'websockets>=12.0',
  'pyyaml>=6.0',
  'croniter>=2.0',
  'ddgs>=9.11',
];

/** Optional feature packs — installed on demand into the writable overlay,
 *  never in the base installer (edit2docs is 141 MB and drags numpy back;
 *  an-web bundles a per-platform V8). */
export const FEATURE_PACKS = {
  docs: { label: '문서 도구 (docx/xlsx/pptx)', deps: ['edit2docs>=0.16.0'], approxMb: 141 },
  browser: { label: '브라우저 도구', deps: ['an-web>=0.9.1'], approxMb: 106 },
};

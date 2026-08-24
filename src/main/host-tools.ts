/**
 * Host tools — the app's own capabilities, offered to the agent.
 *
 * These are the things the Python engine cannot do because they are not
 * Python: seeing the screen, raising a desktop notification, reading the
 * clipboard, opening a folder, telling the user something while a long turn
 * runs. Each one is declared here with its schema, implemented here, and
 * shows up in the agent's tool list automatically.
 *
 * Contract: a handler must ALWAYS resolve — an exception is turned into an
 * error result upstream, and a handler that never returns would hang the
 * agent's tool call, so anything slow needs its own timeout.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostToolSpec } from '@shared/sidecar-protocol';

export interface HostToolContext {
  /** the agent whose turn asked — capture/notify are attributed to it */
  agentId: string;
  agentDir: string;
}

export type HostToolHandler = (
  args: Record<string, unknown>,
  ctx: HostToolContext,
) => Promise<unknown>;

export interface HostToolDeps {
  captureScreen(): Promise<{ mime: string; base64: string; width: number; height: number }>;
  notify(input: { title: string; body: string }): void;
  clipboardRead(): string;
  clipboardWrite(text: string): void;
  openPath(target: string): Promise<void>;
  /** surface a transient message in the app UI */
  say(input: { agentId: string; level: 'info' | 'warn' | 'error'; message: string }): void;
}

export interface HostTool {
  spec: HostToolSpec;
  handle: HostToolHandler;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export function buildHostTools(deps: HostToolDeps): HostTool[] {
  return [
    {
      spec: {
        name: 'ScreenCapture',
        description:
          "Capture the user's screen and return it as an image. Use when the user refers to " +
          'something they can see but has not described, or to verify what an app is showing.',
        schema: { type: 'object', properties: {} },
      },
      handle: async (_args, ctx) => {
        const shot = await deps.captureScreen();
        // hand the agent a path, not a megabyte of base64 in the transcript
        const file = join(ctx.agentDir, 'artifacts', `screen-${Date.now()}.png`);
        await writeFile(file, Buffer.from(shot.base64, 'base64'));
        return { path: file, width: shot.width, height: shot.height, mime: shot.mime };
      },
    },
    {
      spec: {
        name: 'Notify',
        description:
          'Raise a desktop notification. Use to tell the user something finished when they may ' +
          'not be looking at the app.',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'short title' },
            body: { type: 'string', description: 'one or two lines' },
          },
          required: ['title'],
        },
      },
      handle: async (args) => {
        deps.notify({ title: str(args.title, 'Geny'), body: str(args.body) });
        return { delivered: true };
      },
    },
    {
      spec: {
        name: 'Say',
        description:
          'Post a short status line into the chat while the turn is still running. Use for ' +
          'progress on long work, not for the final answer.',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            level: { type: 'string', enum: ['info', 'warn', 'error'] },
          },
          required: ['message'],
        },
      },
      handle: async (args, ctx) => {
        const level = str(args.level, 'info');
        deps.say({
          agentId: ctx.agentId,
          level: level === 'warn' || level === 'error' ? level : 'info',
          message: str(args.message),
        });
        return { posted: true };
      },
    },
    {
      spec: {
        name: 'Clipboard',
        description:
          "Read or write the user's clipboard. `mode:'read'` returns the current text; " +
          "`mode:'write'` replaces it.",
        schema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['read', 'write'] },
            text: { type: 'string', description: "required when mode is 'write'" },
          },
          required: ['mode'],
        },
      },
      handle: async (args) => {
        if (str(args.mode) === 'write') {
          deps.clipboardWrite(str(args.text));
          return { written: true };
        }
        return { text: deps.clipboardRead() };
      },
    },
    {
      spec: {
        name: 'OpenPath',
        description:
          "Open a file or folder in the user's own desktop (Finder/Explorer or the default app). " +
          'Use to hand over a result rather than describing where it is.',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      handle: async (args, ctx) => {
        const target = str(args.path);
        // stay inside the agent's own directory — this tool exists to hand
        // over the agent's work, not to browse the user's disk
        const resolved = target.startsWith('/') ? target : join(ctx.agentDir, target);
        if (!resolved.startsWith(ctx.agentDir)) {
          throw new Error('OpenPath is limited to the agent directory');
        }
        await deps.openPath(resolved);
        return { opened: resolved };
      },
    },
    {
      spec: {
        name: 'ReadUserFile',
        description:
          'Read a file the user pointed at that lives OUTSIDE the agent workspace. Requires the ' +
          'absolute path. Text files only.',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' }, maxBytes: { type: 'number' } },
          required: ['path'],
        },
      },
      handle: async (args) => {
        const target = str(args.path);
        const cap = typeof args.maxBytes === 'number' ? Math.min(args.maxBytes, 400_000) : 200_000;
        const buf = await readFile(target);
        return {
          path: target,
          truncated: buf.byteLength > cap,
          text: buf.subarray(0, cap).toString('utf8'),
        };
      },
    },
  ];
}

export function hostToolSpecs(tools: HostTool[]): HostToolSpec[] {
  return tools.map((t) => t.spec);
}

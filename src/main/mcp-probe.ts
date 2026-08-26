/**
 * Try an MCP server before saving it.
 *
 * Without this, a mistyped command is accepted, stored, handed to the engine
 * and only surfaces as a tool that is quietly absent from the agent's roster
 * — a failure with no error message anywhere the user looks.
 *
 * MCP over stdio is JSON-RPC with newline framing, and the handshake is
 * three messages, so this speaks it directly rather than pulling in the SDK:
 * it runs in the main process, needs no engine, and works while the engine
 * is down — which is exactly when someone is fixing their configuration.
 */
import { spawn } from 'node:child_process';

export interface McpProbeResult {
  ok: boolean;
  /** what the server calls itself */
  server?: string;
  version?: string;
  protocolVersion?: string;
  tools: Array<{ name: string; description?: string }>;
  error?: string;
  /** anything it printed on stderr — usually the real reason */
  stderr?: string;
}

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

export async function probeMcpServer(
  input: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs = 20_000,
): Promise<McpProbeResult> {
  const empty: McpProbeResult = { ok: false, tools: [] };
  if (!input.command.trim()) return { ...empty, error: '실행 명령이 비어 있습니다' };

  return new Promise<McpProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args ?? [], {
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ...empty, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stderr = '';
    let buffer = '';
    let settled = false;
    const info: { server?: string; version?: string; protocolVersion?: string } = {};

    const finish = (result: McpProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ...result, stderr: stderr.trim().slice(-600) || undefined });
    };

    const timer = setTimeout(
      () =>
        finish({
          ...empty,
          error: `${Math.round(timeoutMs / 1000)}초 안에 MCP 핸드셰이크가 끝나지 않았습니다`,
        }),
      timeoutMs,
    );

    const send = (message: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        /* the child died; the exit handler reports it */
      }
    };

    child.on('error', (err) =>
      finish({
        ...empty,
        // ENOENT here means the command itself is not on PATH, which is by
        // far the most common mistake and deserves saying plainly
        error:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `'${input.command}' 를 찾을 수 없습니다 (PATH 확인)`
            : err.message,
      }),
    );
    child.on('exit', (code) =>
      finish({ ...empty, error: `서버가 코드 ${code} 로 종료됐습니다` }),
    );
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // newline-framed JSON: a partial line stays in the buffer
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          // servers that print banners on stdout are common; ignore noise
          continue;
        }
        if (message.error) {
          finish({ ...empty, error: message.error.message ?? 'MCP 오류' });
          return;
        }
        if (message.id === 1 && message.result) {
          const serverInfo = message.result.serverInfo as { name?: string; version?: string } | undefined;
          info.server = serverInfo?.name;
          info.version = serverInfo?.version;
          info.protocolVersion = message.result.protocolVersion as string | undefined;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2 && message.result) {
          const tools = (message.result.tools as Array<{ name: string; description?: string }>) ?? [];
          finish({
            ok: true,
            ...info,
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
          });
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'geny-app', version: '1' },
      },
    });
  });
}

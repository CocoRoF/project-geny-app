/**
 * Shared HTTP plumbing for the voice clients.
 *
 * Two things every call here needs and neither `fetch` gives for free:
 * a timeout (a cold GPU box loading a 3GB model will otherwise hang the
 * caller forever) and an error that says what actually happened — the
 * service's own `{detail: ...}` rather than "500".
 */
export class VoiceError extends Error {
  constructor(message: string, readonly status?: number, readonly url?: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export async function request(
  url: string,
  init: RequestInit & { timeoutSeconds?: number },
): Promise<Response> {
  const { timeoutSeconds = 120, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let response: Response;
  try {
    response = await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new VoiceError(`${timeoutSeconds}초 안에 응답이 없습니다`, undefined, url);
    }
    // a wrong host or a service that is not up looks like this, and the
    // bare cause ("fetch failed") tells the user nothing
    const cause = err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : String(err);
    throw new VoiceError(`연결할 수 없습니다: ${cause}`, undefined, url);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new VoiceError(await describe(response), response.status, url);
  }
  return response;
}

/** Surface the service's own explanation. FastAPI puts it in `detail`,
 *  OpenAI in `error.message`; anything else falls back to the raw body. */
async function describe(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: string } };
    const found = parsed.error?.message ?? parsed.detail;
    if (found) detail = typeof found === 'string' ? found : JSON.stringify(found);
  } catch {
    /* not JSON — the raw body is the best we have */
  }
  return `HTTP ${response.status}${detail ? ` — ${detail}` : ''}`;
}

export const authHeaders = (key?: string): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}` } : {};

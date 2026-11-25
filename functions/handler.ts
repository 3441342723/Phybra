import { CloudAgentsError, createCloudAgentsClient } from './cloud-agents.mjs';
import { CLOUD_API_ORIGIN, CLOUD_REQUEST_TIMEOUT_MS, InterpretError, interpretRequest } from './interpret.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

type CloudClient = {
  request: (path: string, options?: { method?: string; body?: unknown; idempotencyKey?: string }) => Promise<unknown>;
  findResources: (kind: string, metadata: Record<string, string>) => Promise<Array<Record<string, unknown>>>;
};

export type HandlerDeps = {
  client: () => CloudClient;
  sleep: (ms: number) => Promise<void>;
};

const liveDeps: HandlerDeps = {
  client: () => createCloudAgentsClient({ origin: CLOUD_API_ORIGIN, timeoutMs: CLOUD_REQUEST_TIMEOUT_MS }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
}

function failure(error: unknown): Response {
  if (error instanceof InterpretError) return json({ ok: false, error: error.code }, error.status);
  if (error instanceof CloudAgentsError) {
    const code = error.code === 'ai_rate_limited' ? 'rate_limited'
      : error.code === 'ai_not_configured' ? 'service_not_configured'
      : 'service_unavailable';
    return json({ ok: false, error: code }, error.status);
  }
  return json({ ok: false, error: 'service_unavailable' }, 503);
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new InterpretError('unsupported_media_type', 415);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new InterpretError('payload_too_large', 413);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InterpretError('invalid_json', 400);
  }
}

export async function handler(request: Request, deps: HandlerDeps = liveDeps): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  // Health check stays path-independent because the Gateway rewrites the logical
  // `app` segment to the mapped physical name.
  if (request.method === 'GET') {
    const name = new URL(request.url).searchParams.get('name')?.trim() ?? 'Visitor';
    if (!name || name.length > 80) return json({ ok: false, error: 'invalid_name' }, 400);
    return json({ ok: true, message: `Hello, ${name}!` });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  }
  if (!pathname.endsWith('/interpret')) return json({ ok: false, error: 'not_found' }, 404);

  try {
    const draft = await interpretRequest(deps.client(), await readJsonBody(request), deps.sleep);
    return json(draft);
  } catch (error) {
    return failure(error);
  }
}

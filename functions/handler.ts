import { CloudAgentsError, createCloudAgentsClient } from './cloud-agents.mjs';
import { CLOUD_API_ORIGIN, CLOUD_REQUEST_TIMEOUT_MS, InterpretError, startInterpret, interpretResult, parseInterpretInput } from './interpret.ts';
import { createQwenProvider, type QwenProvider } from './qwen.ts';
import { SCENE_CONTRACT_HEADER, SCENE_CONTRACT_REVISION } from './scene-contract.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

type CloudClient = {
  request: (path: string, options?: { method?: string; body?: unknown; idempotencyKey?: string }) => Promise<unknown>;
  findResources: (kind: string, metadata: Record<string, string>) => Promise<Array<Record<string, unknown>>>;
};

export type HandlerDeps = {
  client: () => CloudClient;
  qwen?: QwenProvider;
};

const liveDeps: HandlerDeps = {
  client: () => createCloudAgentsClient({ origin: CLOUD_API_ORIGIN, timeoutMs: CLOUD_REQUEST_TIMEOUT_MS }),
  qwen: createQwenProvider({
    store: {
      put: async (path, bytes) => {
        try {
          return await (await import('./storage-adapter.ts')).put(path, bytes);
        } catch (error) {
          throw Object.assign(new InterpretError('service_unavailable', 503), { detail: `storage-put:${String((error as { name?: unknown })?.name ?? 'unknown')}` });
        }
      },
      get: async (path) => {
        try {
          return await (await import('./storage-adapter.ts')).get(path);
        } catch (error) {
          throw Object.assign(new InterpretError('service_unavailable', 503), { detail: `storage-get:${String((error as { name?: unknown })?.name ?? 'unknown')}` });
        }
      },
    },
  }),
};

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', [SCENE_CONTRACT_HEADER]: SCENE_CONTRACT_REVISION, ...extra } });
}

function failure(error: unknown): Response {
  if (error instanceof InterpretError) {
    const detail = (error as InterpretError & { detail?: string }).detail;
    return json({ ok: false, error: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}), ...(detail ? { detail } : {}) }, error.status);
  }
  if (error instanceof CloudAgentsError) {
    const code = error.code === 'ai_rate_limited' ? 'rate_limited'
      : error.code === 'ai_not_configured' ? 'service_not_configured'
      : 'service_unavailable';
    return json({ ok: false, error: code }, error.status);
  }
  // Class/code names only; never messages, URLs or credentials.
  const name = String((error as { name?: unknown })?.name ?? 'unknown');
  const code = String((error as { code?: unknown })?.code ?? '');
  return json({ ok: false, error: 'service_unavailable', detail: `${name}${code ? `:${code}` : ''}` }, 503);
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
  const clientRevision = request.headers.get(SCENE_CONTRACT_HEADER);
  // Legacy callers can still receive a draft. Version-aware clients fail before
  // spending model calls when only one half of a deployment has been updated.
  if (clientRevision && clientRevision !== SCENE_CONTRACT_REVISION) {
    return json({ ok: false, error: 'scene_contract_mismatch' }, 409);
  }

  // Health check stays path-independent because the Gateway rewrites the logical
  // `app` segment to the mapped physical name.
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const job = url.searchParams.get('job');
    // Polling uses the exact function path with ?job= because the Gateway only
    // guarantees routing for the registered function path, not subpaths.
    if (job !== null || pathname.endsWith('/interpret/result')) {
      try {
        if (deps.qwen?.enabled()) {
          // The GET executes one upstream call inside the request budget; keepalive
          // bytes prevent the gateway from resetting the idle connection.
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(' '));
              const keepalive = setInterval(() => {
                try { controller.enqueue(encoder.encode(' ')); } catch { clearInterval(keepalive); }
              }, 8000);
              deps.qwen!.result(job).then(({ body }) => {
                clearInterval(keepalive);
                controller.enqueue(encoder.encode(JSON.stringify(body)));
                controller.close();
              }).catch((error) => {
                clearInterval(keepalive);
                const code = error instanceof InterpretError ? error.code : 'service_unavailable';
                const diagnostic = error instanceof InterpretError && error.diagnostic ? { diagnostic: error.diagnostic } : {};
                const upstreamStatus = (error as { upstreamStatus?: number })?.upstreamStatus;
                const durationMs = (error as { durationMs?: number })?.durationMs;
                const detail = (error as { detail?: string })?.detail;
                controller.enqueue(encoder.encode(JSON.stringify({ ok: false, error: code, ...diagnostic,
                  ...(upstreamStatus !== undefined ? { upstreamStatus } : {}), ...(durationMs !== undefined ? { durationMs } : {}),
                  ...(detail ? { detail } : {}) })));
                controller.close();
              });
            },
          });
          return new Response(stream, { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', [SCENE_CONTRACT_HEADER]: SCENE_CONTRACT_REVISION } });
        }
        const { status, body } = await interpretResult(deps.client(), job);
        return json(body, status);
      } catch (error) {
        return failure(error);
      }
    }
    const name = url.searchParams.get('name')?.trim() ?? 'Visitor';
    if (!name || name.length > 80) return json({ ok: false, error: 'invalid_name' }, 400);
    return json({ ok: true, message: `Hello, ${name}!` });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  }
  if (!pathname.endsWith('/interpret')) return json({ ok: false, error: 'not_found' }, 404);

  try {
    const body = await readJsonBody(request);
    if (deps.qwen?.enabled()) {
      parseInterpretInput(body);
      const accepted = await deps.qwen.start(body);
      return json(accepted, 202);
    }
    const accepted = await startInterpret(deps.client(), body);
    return json(accepted, 202);
  } catch (error) {
    return failure(error);
  }
}

// Serves the actual dist/ bundle and real Function handler. Only Cloud Agents is
// replaced by a fixture. This server is test-only and never part of a deployment.
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createServer as createViteServer } from 'vite';

export async function startVerificationServer({ scenario = 'valid' } = {}) {
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server: createHttpServer() } }, appType: 'custom' });
  const [{ handler }, { collisionFieldDraft, CORRECTED_COLLISION_FIELD_PROBLEM }, { createVerificationCloud }, { createQwenProvider }, { storage }] = await Promise.all([
    vite.ssrLoadModule('/functions/handler.ts'),
    vite.ssrLoadModule('/src/ai/collision-field-example.ts'),
    vite.ssrLoadModule('/dev/verification-cloud.ts'),
    vite.ssrLoadModule('/functions/qwen.ts'),
    vite.ssrLoadModule('/dev/storage-fake.mjs'),
  ]);
  const reply = collisionFieldDraft();
  if (scenario === 'repair' || scenario === 'regenerate') reply.scene.bodies[0].kind = 'sphere';
  const cloud = createVerificationCloud(reply, scenario === 'repair' ? { repairReply: collisionFieldDraft() } : {});
  const qwenCalls = [];
  const qwen = scenario === 'qwen' ? createQwenProvider({
    getKey: () => 'fixture-key',
    store: {
      put: (path, bytes) => storage.upload(path, bytes, { contentType: 'application/json', upsert: true }),
      get: async (path) => { const response = await storage.download(path); return response.ok ? response.json().catch(() => null) : null; },
    },
    fetchImpl: async (url, init) => {
      qwenCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }) : undefined;
  const requests = [];
  const generationIds = [];
  const root = resolve('dist');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png' };
  const server = createHttpServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') { outgoing.writeHead(204).end(); return; }
      if (url.pathname === '/functions/v1/app/interpret') {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (incoming.method === 'POST') {
          const input = JSON.parse(body);
          if (input.text !== CORRECTED_COLLISION_FIELD_PROBLEM) throw new Error('Verification must submit the full corrected problem');
          generationIds.push(input.generationId ?? null);
          if (scenario === 'regenerate' && input.generationId) reply.scene.bodies[0].kind = 'ball';
        }
        requests.push(incoming.method);
        const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(body ? { body } : {}) });
        const response = await handler(request, { client: () => cloud, ...(qwen ? { qwen } : {}) });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const file = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + sep)) { outgoing.writeHead(403).end(); return; }
      const body = await readFile(file);
      outgoing.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      outgoing.end(body);
    } catch (error) {
      outgoing.writeHead(500, { 'content-type': 'text/plain' });
      outgoing.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    problem: CORRECTED_COLLISION_FIELD_PROBLEM,
    requests, cloud, generationIds, scenario, qwenCalls,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await vite.close();
    },
  };
}

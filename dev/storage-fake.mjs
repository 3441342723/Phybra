// Test/preview fake for the platform-injected Storage SDK. Never deployed.
const objects = new Map();
export const storage = {
  async upload(objectPath, bytes, options = {}) {
    if (!options.upsert && objects.has(objectPath)) throw new Error('exists');
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(await new Blob([bytes]).arrayBuffer());
    objects.set(objectPath, buf);
    return { ok: true };
  },
  async download(objectPath) {
    const buf = objects.get(objectPath);
    if (!buf) return new Response('', { status: 404 });
    return new Response(buf, { status: 200, headers: { 'content-type': 'application/json' } });
  },
  async remove(paths) {
    for (const p of paths) objects.delete(p);
    return { ok: true };
  },
  async list(prefix) {
    return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  },
};
export function __clearStorage() { objects.clear(); }
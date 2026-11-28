// The Sites Worker only injects platform modules that appear in the static import
// graph; this adapter is that static reference. Locally the vite alias replaces the
// injected module with dev/storage-fake.mjs. Never ship a real _qoder directory.
// @ts-ignore platform-injected at deployment
import { storage } from './_qoder/storage.mjs';

export async function put(path: string, bytes: Uint8Array): Promise<unknown> {
  return storage.upload(path, bytes, { contentType: 'application/json', upsert: true });
}

export async function get(path: string): Promise<any | null> {
  let response: Response;
  try {
    response = await storage.download(path);
  } catch {
    // The SDK throws StorageError for absent objects instead of a 404 response.
    return null;
  }
  if (!response.ok) return null;
  return response.json().catch(() => null);
}
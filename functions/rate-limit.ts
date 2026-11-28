import { InterpretError } from './interpret.ts';

export type RateLimitConfig = {
  minIntervalMs: number;
  dailyPerIp: number;
  dailyGlobal: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  minIntervalMs: 10_000,
  dailyPerIp: 20,
  dailyGlobal: 200,
};

export type QuotaCounters = { ipCount: number; globalCount: number };

export interface QuotaStore {
  lastRequestAt(ipHash: string): Promise<number | null>;
  counters(day: string, ipHash: string): Promise<QuotaCounters>;
  /** Atomically checks the limits and, when allowed, records one request. */
  consume(day: string, ipHash: string, at: number, limits: Pick<RateLimitConfig, 'dailyPerIp' | 'dailyGlobal'>): Promise<{ allowed: boolean } & QuotaCounters>;
}

/**
 * Per-isolate memory store: best-effort fallback only. It protects a single
 * server instance and is lost on restart, so the daily quota is not trustworthy
 * across instances. The DB-backed store is a follow-up task once the site has
 * database capability (prepare_site databaseAccess + migration).
 */
export class MemoryQuotaStore implements QuotaStore {
  private days = new Map<string, { global: number; perIp: Map<string, number> }>();
  private lastAt = new Map<string, number>();

  async lastRequestAt(ipHash: string): Promise<number | null> {
    return this.lastAt.get(ipHash) ?? null;
  }

  async counters(day: string, ipHash: string): Promise<QuotaCounters> {
    const bucket = this.days.get(day);
    return { ipCount: bucket?.perIp.get(ipHash) ?? 0, globalCount: bucket?.global ?? 0 };
  }

  async consume(day: string, ipHash: string, at: number, limits: Pick<RateLimitConfig, 'dailyPerIp' | 'dailyGlobal'>) {
    let bucket = this.days.get(day);
    if (!bucket) {
      bucket = { global: 0, perIp: new Map() };
      this.days.set(day, bucket);
    }
    const ipCount = bucket.perIp.get(ipHash) ?? 0;
    if (ipCount + 1 > limits.dailyPerIp || bucket.global + 1 > limits.dailyGlobal) {
      return { allowed: false, ipCount, globalCount: bucket.global };
    }
    bucket.perIp.set(ipHash, ipCount + 1);
    bucket.global += 1;
    this.lastAt.set(ipHash, at);
    return { allowed: true, ipCount: ipCount + 1, globalCount: bucket.global };
  }
}

export async function clientIpHash(request: Request): Promise<string> {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0].trim() || request.headers.get('x-real-ip')?.trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class RateLimiter {
  private store: QuotaStore;
  private config: RateLimitConfig;
  private now: () => number;

  constructor(store: QuotaStore, config: RateLimitConfig = DEFAULT_RATE_LIMIT, now: () => number = () => Date.now()) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  /**
   * Gate before accepting a job: enforces the min-interval rule and rejects
   * exhausted quotas without counting. Polling GETs never call this.
   */
  async gate(request: Request): Promise<void> {
    const ipHash = await clientIpHash(request);
    const at = this.now();
    const last = await this.store.lastRequestAt(ipHash);
    if (last !== null && at - last < this.config.minIntervalMs) {
      throw new InterpretError('rate_limited', 429);
    }
    const day = new Date(at).toISOString().slice(0, 10);
    const { ipCount, globalCount } = await this.store.counters(day, ipHash);
    if (ipCount >= this.config.dailyPerIp || globalCount >= this.config.dailyGlobal) {
      throw new InterpretError('quota_exceeded', 429);
    }
  }

  /** Counts one accepted NEW job. Fingerprint-resumed submissions must not call this. */
  async record(request: Request): Promise<void> {
    const ipHash = await clientIpHash(request);
    const at = this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    const result = await this.store.consume(day, ipHash, at, this.config);
    if (!result.allowed) throw new InterpretError('quota_exceeded', 429);
  }

  /** gate + record in one step, for callers that accept a job unconditionally. */
  async check(request: Request): Promise<void> {
    await this.gate(request);
    await this.record(request);
  }

  /** Rejects exhausted quotas without counting; for resumed jobs. */
  async peek(request: Request): Promise<void> {
    const ipHash = await clientIpHash(request);
    const at = this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    const { ipCount, globalCount } = await this.store.counters(day, ipHash);
    if (ipCount >= this.config.dailyPerIp || globalCount >= this.config.dailyGlobal) {
      throw new InterpretError('quota_exceeded', 429);
    }
  }
}

export function configFromEnv(
  env: (key: string) => string | undefined = (key) => (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno?.env?.get(key),
): RateLimitConfig {
  const num = (key: string, fallback: number) => {
    const raw = env(key);
    const value = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    minIntervalMs: num('RATE_MIN_INTERVAL_MS', DEFAULT_RATE_LIMIT.minIntervalMs),
    dailyPerIp: num('RATE_DAILY_PER_IP', DEFAULT_RATE_LIMIT.dailyPerIp),
    dailyGlobal: num('RATE_DAILY_GLOBAL', DEFAULT_RATE_LIMIT.dailyGlobal),
  };
}

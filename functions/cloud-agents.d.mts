export class CloudAgentsError extends Error {
  constructor(code: string, status?: number, outcome?: string);
  code: string;
  status: number;
  outcome: string;
}

export function createCloudAgentsClient(options: {
  origin: string;
  getToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  diagnostics?: (event: Record<string, unknown>) => void;
}): {
  request(path: string, options?: { method?: string; body?: unknown; idempotencyKey?: string }): Promise<any>;
  findResources(kind: string, metadata: Record<string, string>): Promise<Array<Record<string, unknown>>>;
};

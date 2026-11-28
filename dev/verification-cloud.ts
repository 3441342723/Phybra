/** Test-only Cloud Agents substitute. It never uses credentials or the network. */
export function createVerificationCloud(reply: unknown, repairOptions: { repairReply?: unknown } = {}) {
  const sessions: Array<Record<string, any>> = [];
  const calls: string[] = [];
  const prompts: unknown[] = [];
  const contents = new Map<string, unknown>();
  return {
    sessions, calls, prompts,
    async findResources() { return []; },
    async request(path: string, options?: { method?: string; body?: any }) {
      calls.push(`${options?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/cloud/models') return { data: [{ id: 'verification', is_enabled: true }] };
      if (path === '/api/v1/cloud/agents') return { id: 'agent_verification', version: 1 };
      if (path === '/api/v1/cloud/environments') return { id: 'env_verification' };
      if (path === '/api/v1/cloud/sessions' && options?.method === 'POST') {
        const session = { id: `session_${sessions.length + 1}`, metadata: options.body.metadata, created_at: new Date().toISOString() };
        sessions.push(session);
        return session;
      }
      if (path.startsWith('/api/v1/cloud/sessions?')) return { data: sessions, has_more: false };
      if (path.endsWith('/events') && options?.method === 'POST') {
        prompts.push(options.body.events[0].content);
        contents.set(path.split('/')[5], options.body.events[0].content);
        return { id: 'event_verification' };
      }
      if (path.includes('/events?')) {
        const session = sessions.find(s => s.id === path.split('/')[5]);
        const response = session?.metadata.repairOf && Object.hasOwn(repairOptions, 'repairReply') ? repairOptions.repairReply : reply;
        return { data: [
          { type: 'user.message', content: contents.get(session?.id) ?? [] },
          { type: 'agent.message', content: [{ type: 'text', text: typeof response === 'string' ? response : JSON.stringify(response) }] },
        ], has_more: false };
      }
      throw new Error('Unexpected verification cloud request');
    },
  };
}

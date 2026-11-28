/** Detect an unfinished JSON stream without pretending malformed JSON is valid. */
export function unfinishedJson(text: string): boolean {
  const value = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!value.startsWith('{') && !value.startsWith('[')) return false;
  const stack: string[] = [];
  let quoted = false, escaped = false;
  for (const char of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return false;
    }
  }
  return quoted || stack.length > 0;
}

export type DraftDiagnostic = 'object_type' | 'binding' | 'reference' | 'field' | 'json' | 'structure';

/** Only return known categories; never send model output or arbitrary error text to the browser. */
export function draftDiagnostic(code: string, reason: string): DraftDiagnostic {
  if (code === 'ai_draft_unparseable') return 'json';
  if (/bodies\.\d+\.kind/.test(reason)) return 'object_type';
  if (/bindings|param/.test(reason)) return 'binding';
  if (/引用|路径|重复/.test(reason)) return 'reference';
  if (/fields\./.test(reason)) return 'field';
  return 'structure';
}

export function repairContent(original: Array<Record<string, unknown>>, reply: string, reason: string): Array<Record<string, unknown>> | null {
  // Refuse oversized repairs rather than truncating away conditions or evidence.
  if (!original.length || reply.length > 96000) return null;
  const content = [
    ...original,
    { type: 'text', text: `\n以下是上一轮草稿格式修正任务，只修正结构，不解物理题。原题文字和题图在上方。\n校验失败：${reason}\n请按系统给定的 SceneDraft 契约重新输出完整 JSON，保留原数值、场、电荷、所有待求及原文依据。不要为了通过校验删除条件、改题意、推算并填入后阶段速度，或把未知量编为零。分阶段依赖仍由本地求解器处理。若条件不足，用 null 和 unknown 明示。只输出完整 JSON。\n上一轮输出：\n${reply}` },
  ];
  const size = new TextEncoder().encode(JSON.stringify({ events: [{ type: 'user.message', content }] })).byteLength;
  return size > 1024 * 1024 ? null : content;
}

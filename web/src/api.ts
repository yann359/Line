export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const form = body instanceof FormData;
  const r = await fetch(`/api${path}`, { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: body === undefined || form ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || `请求未完成（${r.status}）`); }
  return r.status === 204 ? undefined as T : r.json();
}

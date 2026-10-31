import { requestKey } from './requestKey';
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, entry]) => key !== 'request_key' && entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}

/** Keep the same command identity after an uncertain response, until success or input change. */
export class CommandKeys {
  private readonly pending = new Map<string, string>();
  constructor(private readonly newKey: () => string = () => requestKey()) {}
  private signature(path: string, body: unknown) { return path + '\n' + JSON.stringify(stable(body)); }
  prepare<T extends Record<string, unknown>>(path: string, body: T): T {
    if (typeof body.request_key !== 'string') return body;
    const signature = this.signature(path, body);
    let key = this.pending.get(signature);
    if (!key) {
      key = this.newKey();
      if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(signature, key);
    }
    return { ...body, request_key: key };
  }
  complete(path: string, body: Record<string, unknown>) {
    const signature = this.signature(path, body);
    if (this.pending.get(signature) === body.request_key) this.pending.delete(signature);
  }
}

/** Removes secrets before anything is written to audit_logs. */
const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credentials?|x-rapidapi-key/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) return value.slice(0, 4000) + "…[truncated]";
  return value;
}

/** Strips api_key / key query parameters from URLs before logging them. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_KEYS.test(k) || k === "key") u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    return url;
  }
}

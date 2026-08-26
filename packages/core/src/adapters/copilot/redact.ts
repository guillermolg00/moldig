/**
 * D64, the one redaction rule every adapter shares, applied to Copilot's settings: a value
 * becomes `"<redacted>"` when its key looks secret **or** the value is a bare token (24 or more
 * characters of `[A-Za-z0-9_-./+=]` with no spaces). `env` and `headers` maps are redacted whole
 * — key names survive, values never do. Key names themselves are always kept verbatim.
 */
import { isRecord } from "../../scan/fs.js";

export const REDACTED = "<redacted>";

const SECRET_MAPS = new Set(["env", "headers", "auth"]);
const SECRET_KEY =
  /(token|secret|key|password|passwd|auth|credential|cookie|session[_-]?id|api[_-]?key)/i;
const SECRET_VALUE = /^[A-Za-z0-9_\-./+=]{24,}$/;

export function redactString(value: string, key: string | null): string {
  if (key !== null && SECRET_KEY.test(key)) return REDACTED;
  return SECRET_VALUE.test(value) ? REDACTED : value;
}

export function redactValue(value: unknown, key: string | null): unknown {
  if (key !== null && SECRET_MAPS.has(key) && isRecord(value)) {
    return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
  }
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]),
    );
  }
  return value;
}

/** Redacts a whole settings map, plus the keys the caller names as identifying rather than configuration. */
export function redactSettings(
  data: Record<string, unknown>,
  always: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = always.includes(key) ? REDACTED : redactValue(value, key);
  }
  return out;
}

/**
 * A URL with its query string and userinfo dropped (D64), plus the normalised endpoint used to
 * pair two configurations of one server. An unparsable value (a redacted fixture string) is kept
 * as it stands: it is already not a secret.
 */
export function sanitiseUrl(raw: string): { url: string; endpoint: string } {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return {
      url: parsed.toString(),
      endpoint: `${parsed.host}${parsed.pathname}`.replace(/\/$/, ""),
    };
  } catch {
    return { url: raw, endpoint: raw };
  }
}

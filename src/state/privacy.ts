export interface RedactionOptions {
  readonly maxDepth?: number;
}

const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "token",
  "accesstoken",
  "idtoken",
  "authtoken",
]);

const SECRET_KEY_SUFFIXES = ["apikey", "password", "privatekey", "secret", "token"];

const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@"],
  [
    /\b(api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization|client[_-]?secret)\b(\s*[:=]\s*)(["']?)([^\s"',;]{4,})\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
  [
    /(["'])(api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization|client[_-]?secret)\1(\s*:\s*)(["'])([^"']*)\4/gi,
    "$1$2$1$3$4[REDACTED]$4",
  ],
];

/**
 * Redact common secret shapes from free-form text. This is a defence-in-depth
 * measure for previews and CLI exports, not a substitute for capture defaults.
 */
export function redactText(text: string): string {
  let result = redactFreeText(text);
  try {
    const parsed: unknown = JSON.parse(result);
    if (Array.isArray(parsed) || isRecord(parsed)) {
      result = stringify(redactParsedJson(parsed));
    }
  } catch {
    // Most previews are plain text, not serialized JSON.
  }
  return result;
}

function redactFreeText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function redactParsedJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactFreeText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 12) return "[TRUNCATED_DEPTH]";
  if (Array.isArray(value)) {
    return value.map((item) => redactParsedJson(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSecretKey(key) ? "[REDACTED]" : redactParsedJson(item, depth + 1);
  }
  return result;
}

/**
 * Recursively redact secret-looking object keys and redact string values.
 * Cycles are preserved as a marker because trace data must always serialize.
 */
export function redactSecrets(value: unknown, options: RedactionOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 12;
  const seen = new WeakSet<object>();

  const walk = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return redactText(current);
    if (current === null || typeof current !== "object") return current;
    if (depth >= maxDepth) return "[TRUNCATED_DEPTH]";
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((item) => walk(item, depth + 1));
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return { name: current.name, message: redactText(current.message) };
    }

    const record = current as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      result[key] = isSecretKey(key) ? "[REDACTED]" : walk(item, depth + 1);
    }
    return result;
  };

  return walk(value, 0);
}

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  if (SECRET_KEYS.has(normalized)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Truncate to at most `maxChars` characters. Zero disables preview capture. */
export function truncatePreview(text: string, maxChars: number): string | null {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return null;
  const limit = Math.floor(maxChars);
  return text.length <= limit ? text : text.slice(0, limit);
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Produce a stable, redacted text view of a tool result or error for previews
 * and byte accounting. Structured output is preferred over host content.
 */
export function previewText(value: unknown): string {
  if (typeof value === "string") return redactText(value);
  if (value === undefined) return "";
  if (isRecord(value) && "output" in value && value.output !== undefined) {
    return typeof value.output === "string"
      ? redactText(value.output)
      : stringify(redactSecrets(value.output));
  }
  if (isRecord(value) && "content" in value) {
    const content = value.content;
    if (typeof content === "string") return redactText(content);
    if (Array.isArray(content)) {
      const text = content
        .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
        .filter((part) => part.length > 0)
        .join("\n");
      if (text) return redactText(text);
    }
  }
  return redactText(stringify(value));
}

export function stringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") return entry.toString();
      if (entry instanceof Error) return { name: entry.name, message: redactText(entry.message) };
      return entry;
    });
    return serialized === undefined ? "null" : serialized;
  } catch {
    return JSON.stringify({ error: "unserializable trace data" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

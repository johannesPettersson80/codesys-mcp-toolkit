/**
 * Values read from truST.
 *
 * `eval` answers with Rust Debug text such as `LReal(0.73)`, `String("OK")` or
 * `Enum(EnumValue { type_name: "E_Mode", variant_name: "AUTO", numeric_value: 1 })`
 * (TRUST-GAPS B4). This module turns that into typed values and back into
 * Structured Text literals.
 */

export type StValue =
  | { kind: "number"; type: string; value: number }
  | { kind: "bool"; type: "BOOL"; value: boolean }
  | { kind: "string"; type: string; value: string }
  | { kind: "time"; type: string; ms: number }
  | { kind: "enum"; type?: string; name: string; numeric?: number }
  | { kind: "other"; type: string; text: string };

const NUMERIC: Record<string, string> = {
  sint: "SINT", int: "INT", dint: "DINT", lint: "LINT",
  usint: "USINT", uint: "UINT", udint: "UDINT", ulint: "ULINT",
  byte: "BYTE", word: "WORD", dword: "DWORD", lword: "LWORD",
  real: "REAL", lreal: "LREAL",
};

function unescapeRust(s: string): string {
  return s.replace(/\\(u\{([0-9a-fA-F]+)\}|.)/g, (_m, c: string, hex?: string) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ({ n: "\n", r: "\r", t: "\t", "0": "\0" } as Record<string, string>)[c] ?? c;
  });
}

/** Parse one truST eval value text. */
export function parseTrustValue(text: string): StValue {
  const s = text.trim();
  const m = /^([A-Za-z]+)\(([\s\S]*)\)$/.exec(s);
  if (!m) {
    if (/^(true|false)$/i.test(s)) return { kind: "bool", type: "BOOL", value: /^true$/i.test(s) };
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return { kind: "number", type: "", value: Number(s) };
    return { kind: "other", type: "", text: s };
  }
  const tag = m[1]!;
  const body = m[2]!;
  const num = NUMERIC[tag.toLowerCase()];
  if (num) return { kind: "number", type: num, value: Number(body) };
  if (tag === "Bool") return { kind: "bool", type: "BOOL", value: body === "true" };
  if (tag === "String" || tag === "WString") {
    const sm = /^"([\s\S]*)"$/.exec(body);
    return { kind: "string", type: tag.toUpperCase(), value: sm ? unescapeRust(sm[1]!) : body };
  }
  if (tag === "Time" || tag === "LTime") {
    const secs = Number(/secs:\s*(\d+)/.exec(body)?.[1] ?? 0);
    const nanos = Number(/nanos:\s*(-?\d+)/.exec(body)?.[1] ?? 0);
    return { kind: "time", type: tag.toUpperCase(), ms: secs * 1000 + nanos / 1e6 };
  }
  if (tag === "Enum") {
    const type = /type_name:\s*"([^"]*)"/.exec(body)?.[1];
    const name = /variant_name:\s*"([^"]*)"/.exec(body)?.[1] ?? body;
    const n = /numeric_value:\s*(-?\d+)/.exec(body)?.[1];
    return { kind: "enum", type, name, numeric: n === undefined ? undefined : Number(n) };
  }
  return { kind: "other", type: tag.toUpperCase(), text: body };
}

function timeLiteral(ms: number): string {
  if (ms === 0) return "T#0ms";
  const parts: string[] = [];
  let rest = Math.abs(ms);
  for (const [u, f] of [["h", 3600000], ["m", 60000], ["s", 1000]] as const) {
    if (rest >= f) {
      const n = Math.floor(rest / f);
      parts.push(`${n}${u}`);
      rest -= n * f;
    }
  }
  if (rest > 0) parts.push(`${Math.round(rest * 1000) / 1000}ms`);
  return `${ms < 0 ? "-" : ""}T#${parts.join("")}`;
}

/** Format a value as Structured Text (what CODESYS would show). */
export function formatValue(v: StValue): string {
  switch (v.kind) {
    case "number":
      return Number.isInteger(v.value) && /REAL/.test(v.type) ? v.value.toFixed(1) : String(v.value);
    case "bool":
      return v.value ? "TRUE" : "FALSE";
    case "string":
      return `'${v.value.replace(/[$']/g, (c) => "$" + c)}'`;
    case "time":
      return timeLiteral(v.ms);
    case "enum":
      return v.type ? `${v.type}.${v.name}` : v.name;
    case "other":
      return v.text;
  }
}

/** A CODESYS value literal as truST's `set`/`var.force` grammar takes it. */
export function toTrustLiteral(text: string): string {
  const t = text.trim();
  // CODESYS writes enum values as E.X; truST's value grammar takes E#X (TRUST-GAPS B12).
  const e = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  if (e) return `${e[1]}#${e[2]}`;
  return t;
}

/** A number from a value, for metrics. */
export function numeric(v: StValue): number | undefined {
  if (v.kind === "number") return v.value;
  if (v.kind === "bool") return v.value ? 1 : 0;
  if (v.kind === "time") return v.ms;
  if (v.kind === "enum") return v.numeric;
  return undefined;
}

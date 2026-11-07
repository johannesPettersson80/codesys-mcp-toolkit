/**
 * A small Structured Text expression evaluator for breakpoint conditions.
 *
 * truST's breakpoints take only compiled conditions, and the compiler lives
 * inside trust-debug (TRUST-GAPS B1). Until truST can compile condition text,
 * the toolkit evaluates conditions itself when a breakpoint is hit: it reads
 * the variables the condition names with `eval` and computes the result here.
 *
 * Supported: literals (numbers, 16#FF, TRUE/FALSE, 'text', T#2s, E#X, E.X),
 * variable paths (a.b.c, a[1]), NOT, unary -, **, * / MOD, + -,
 * < > <= >=, = <>, AND/&, XOR, OR, parentheses.
 */
import type { StValue } from "./values.js";

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "time"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

export type Expr =
  | { k: "lit"; v: StValue }
  | { k: "var"; path: string }
  | { k: "un"; op: string; a: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr };

export class ExprError extends Error {}

const KEYWORD_OPS = new Set(["AND", "OR", "XOR", "NOT", "MOD"]);

function timeMs(lit: string): number {
  let ms = 0;
  for (const m of lit.replace(/^(t|time|lt|ltime)#/i, "").replace(/_/g, "").matchAll(/(\d+(?:\.\d+)?)(d|h|ms|m|s|us|ns)/gi)) {
    ms += Number(m[1]) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 } as Record<string, number>)[m[2]!.toLowerCase()]!;
  }
  return ms;
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^(t|time|lt|ltime)#[0-9a-z_.]+/i.exec(rest))) {
      out.push({ t: "time", v: timeMs(m[0]) });
    } else if ((m = /^(?:[A-Za-z_]+#)?(\d+)#([0-9A-Fa-f_]+)/.exec(rest))) {
      out.push({ t: "num", v: parseInt(m[2]!.replace(/_/g, ""), Number(m[1])) });
    } else if ((m = /^(?:(?:L?REAL|U?[SDL]?INT|BYTE|L?D?WORD)#)?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest))) {
      out.push({ t: "num", v: Number(m[0].replace(/^[A-Za-z]+#/, "").replace(/_/g, "")) });
    } else if (c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "$" && j + 1 < src.length) {
          const e = src[j + 1]!;
          s += ({ N: "\n", n: "\n", T: "\t", t: "\t", R: "\r", r: "\r", L: "\n", l: "\n" } as Record<string, string>)[e] ?? e;
          j += 2;
        } else s += src[j++];
      }
      if (src[j] !== "'") throw new ExprError("unterminated string");
      out.push({ t: "str", v: s });
      m = { 0: src.slice(i, j + 1) } as unknown as RegExpExecArray;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*(?:#[A-Za-z_][A-Za-z0-9_]*)?(?:\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_]*|\[\s*\d+\s*\]))*/.exec(rest))) {
      const word = m[0].replace(/\s+/g, "");
      if (KEYWORD_OPS.has(word.toUpperCase())) out.push({ t: "op", v: word.toUpperCase() });
      else out.push({ t: "id", v: word });
    } else if ((m = /^(\*\*|<=|>=|<>|[-+*/()<>=&])/.exec(rest))) {
      out.push({ t: "op", v: m[0] === "&" ? "AND" : m[0] });
    } else {
      throw new ExprError(`unexpected '${c}' at ${i + 1}`);
    }
    i += m[0].length;
  }
  return out;
}

const LEVELS: string[][] = [["OR"], ["XOR"], ["AND"], ["=", "<>"], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "MOD"], ["**"]];

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;

  const level = (n: number): Expr => {
    if (n === LEVELS.length) return unary();
    let a = level(n + 1);
    for (let tk = peek(); tk?.t === "op" && LEVELS[n]!.includes(tk.v); tk = peek()) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: "bin", op, a, b: level(n + 1) };
    }
    return a;
  };
  const unary = (): Expr => {
    if (isOp("NOT")) {
      p++;
      return { k: "un", op: "NOT", a: unary() };
    }
    if (isOp("-")) {
      p++;
      return { k: "un", op: "-", a: unary() };
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    return primary();
  };
  const primary = (): Expr => {
    const t = toks[p++];
    if (!t) throw new ExprError("unexpected end of expression");
    if (t.t === "op" && t.v === "(") {
      const e = level(0);
      if (!isOp(")")) throw new ExprError("missing ')'");
      p++;
      return e;
    }
    if (t.t === "num") return { k: "lit", v: { kind: "number", type: "", value: t.v } };
    if (t.t === "str") return { k: "lit", v: { kind: "string", type: "STRING", value: t.v } };
    if (t.t === "time") return { k: "lit", v: { kind: "time", type: "TIME", ms: t.v } };
    if (t.t === "id") {
      if (/^true$/i.test(t.v)) return { k: "lit", v: { kind: "bool", type: "BOOL", value: true } };
      if (/^false$/i.test(t.v)) return { k: "lit", v: { kind: "bool", type: "BOOL", value: false } };
      const hashEnum = /^([A-Za-z_][A-Za-z0-9_]*)#([A-Za-z_][A-Za-z0-9_]*)$/.exec(t.v);
      if (hashEnum) return { k: "lit", v: { kind: "enum", type: hashEnum[1], name: hashEnum[2]! } };
      return { k: "var", path: t.v };
    }
    throw new ExprError(`unexpected '${t.v}'`);
  };
  const e = level(0);
  if (p < toks.length) throw new ExprError(`unexpected '${(toks[p] as { v: unknown }).v}'`);
  return e;
}

export function variablesOf(e: Expr, out = new Set<string>()): Set<string> {
  if (e.k === "var") out.add(e.path);
  else if (e.k === "un") variablesOf(e.a, out);
  else if (e.k === "bin") {
    variablesOf(e.a, out);
    variablesOf(e.b, out);
  }
  return out;
}

const num = (v: StValue): number => {
  if (v.kind === "number") return v.value;
  if (v.kind === "time") return v.ms;
  if (v.kind === "bool") return v.value ? 1 : 0;
  if (v.kind === "enum" && v.numeric !== undefined) return v.numeric;
  throw new ExprError(`${v.kind} value used as a number`);
};
const bool = (v: StValue): boolean => {
  if (v.kind === "bool") return v.value;
  if (v.kind === "number") return v.value !== 0;
  throw new ExprError(`${v.kind} value used as BOOL`);
};
const B = (value: boolean): StValue => ({ kind: "bool", type: "BOOL", value });
const N = (value: number): StValue => ({ kind: "number", type: "", value });

function equal(a: StValue, b: StValue): boolean {
  if (a.kind === "enum" && b.kind === "enum") {
    return a.name.toUpperCase() === b.name.toUpperCase() && (!a.type || !b.type || a.type.toUpperCase() === b.type.toUpperCase());
  }
  if (a.kind === "enum" || b.kind === "enum") {
    const en = (a.kind === "enum" ? a : b) as Extract<StValue, { kind: "enum" }>;
    const other = a.kind === "enum" ? b : a;
    return other.kind === "number" && en.numeric === other.value;
  }
  if (a.kind === "string" || b.kind === "string") return a.kind === "string" && b.kind === "string" && a.value === b.value;
  if (a.kind === "bool" && b.kind === "bool") return a.value === b.value;
  return num(a) === num(b);
}

/** Evaluate with already-read variable values (keyed by path as written). */
export function evaluate(e: Expr, vars: Map<string, StValue>): StValue {
  switch (e.k) {
    case "lit":
      return e.v;
    case "var": {
      const v = vars.get(e.path);
      if (!v) throw new ExprError(`no value for ${e.path}`);
      return v;
    }
    case "un": {
      const a = evaluate(e.a, vars);
      return e.op === "NOT" ? B(!bool(a)) : N(-num(a));
    }
    case "bin": {
      const a = evaluate(e.a, vars);
      if (e.op === "AND" && !bool(a)) return B(false);
      if (e.op === "OR" && bool(a)) return B(true);
      const b = evaluate(e.b, vars);
      switch (e.op) {
        case "AND":
        case "OR":
          return B(bool(b));
        case "XOR":
          return B(bool(a) !== bool(b));
        case "=":
          return B(equal(a, b));
        case "<>":
          return B(!equal(a, b));
        case "<":
          return B(num(a) < num(b));
        case ">":
          return B(num(a) > num(b));
        case "<=":
          return B(num(a) <= num(b));
        case ">=":
          return B(num(a) >= num(b));
        case "+":
          return N(num(a) + num(b));
        case "-":
          return N(num(a) - num(b));
        case "*":
          return N(num(a) * num(b));
        case "/":
          return N(num(a) / num(b));
        case "MOD":
          return N(num(a) % num(b));
        case "**":
          return N(num(a) ** num(b));
      }
    }
  }
  throw new ExprError("bad expression");
}

/**
 * Evaluate a condition, reading variables through `read`. A dotted name that
 * truST doesn't know (`E_Mode.AUTO`) is taken as an enum literal, which is how
 * CODESYS writes enum values.
 */
export async function evaluateCondition(src: string, read: (path: string) => Promise<StValue>): Promise<boolean> {
  const e = parseExpr(src);
  const vars = new Map<string, StValue>();
  for (const path of variablesOf(e)) {
    try {
      vars.set(path, await read(path));
    } catch (err) {
      const en = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
      if (en && /unknown identifier/i.test((err as Error).message)) vars.set(path, { kind: "enum", type: en[1], name: en[2]! });
      else throw err;
    }
  }
  return bool(evaluate(e, vars));
}

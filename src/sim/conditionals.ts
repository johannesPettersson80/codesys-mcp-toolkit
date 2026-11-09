/**
 * CODESYS conditional compilation for the simulation mirror.
 *
 * truST evaluates `{IF defined (X)}` but has no way to receive the project's
 * compiler defines, and ignores `{define X}` (TRUST-GAPS A8). So the mirror
 * resolves the blocks itself, line for line: the active branch stays, every
 * other line (the pragmas too) becomes an empty line, so line numbers and the
 * mirror's line map are unchanged.
 *
 * Handled: `{IF}`, `{ELSIF}`, `{ELSE}`, `{END_IF}` each on a line of its own;
 * conditions made of `defined(X)`, `project_defined(X)`, NOT, AND, OR and
 * parentheses; `{define X}` / `{undefine X}` lines in the same object. A block
 * with any other condition (hastype, hasvalue, defined(variable: x), ...) is
 * left for truST to evaluate, and reported.
 */

export interface Defines {
  /** The application's compiler defines. */
  defines?: string[];
  /** Project defines (`project_defined(X)`). */
  projectDefines?: string[];
}

export interface Resolved {
  text: string;
  /** Conditions the resolver couldn't evaluate (left as they were). */
  unresolved: string[];
  /** True when some block was resolved. */
  changed: boolean;
}

const PRAGMA = /^\s*\{\s*(IF|ELSIF|ELSE|END_IF)\b\s*(.*?)\s*\}\s*$/i;
const DEFINE = /^\s*\{\s*(define|undefine)\s+([A-Za-z_][A-Za-z0-9_]*)\b[^}]*\}\s*$/i;

type Node = { kind: "line"; index: number } | { kind: "if"; branches: { cond: string | null; pragma: number; body: Node[] }[]; end: number };

/** Evaluate a condition; undefined when it uses anything beyond defined/project_defined/NOT/AND/OR. */
export function evaluateCondition(cond: string, isDefined: (x: string) => boolean, isProjectDefined: (x: string) => boolean): boolean | undefined {
  const tokens = cond.match(/[A-Za-z_][A-Za-z0-9_]*|\(|\)|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i]?.toUpperCase();
  const fail = Symbol();
  const primary = (): boolean => {
    const t = peek();
    if (t === "(") {
      i++;
      const v = or();
      if (tokens[i++] !== ")") throw fail;
      return v;
    }
    if (t === "DEFINED" || t === "PROJECT_DEFINED") {
      i++;
      if (tokens[i++] !== "(") throw fail;
      const name = tokens[i++];
      if (!name || !/^[A-Za-z_]/.test(name) || tokens[i++] !== ")") throw fail;
      return t === "DEFINED" ? isDefined(name) : isProjectDefined(name);
    }
    throw fail;
  };
  const not = (): boolean => {
    if (peek() === "NOT") {
      i++;
      return !not();
    }
    return primary();
  };
  const and = (): boolean => {
    let v = not();
    while (peek() === "AND") {
      i++;
      v = not() && v;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (peek() === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length ? v : undefined;
  } catch {
    return undefined;
  }
}

export function resolveConditionals(text: string, d: Defines = {}): Resolved {
  if (!/\{\s*(IF|define|undefine)\b/i.test(text)) return { text, unresolved: [], changed: false };
  const lines = text.split("\n");
  const local = new Set((d.defines ?? []).map((x) => x.toLowerCase()));
  const project = new Set((d.projectDefines ?? []).map((x) => x.toLowerCase()));

  // Parse into blocks; give up (unchanged) on unbalanced pragmas.
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: "if" }>; parent: Node[] }[] = [];
  let cur = root;
  for (let k = 0; k < lines.length; k++) {
    const m = PRAGMA.exec(lines[k]!);
    if (!m) {
      cur.push({ kind: "line", index: k });
      continue;
    }
    const kw = m[1]!.toUpperCase();
    if (kw === "IF") {
      const node: Extract<Node, { kind: "if" }> = { kind: "if", branches: [{ cond: m[2]!, pragma: k, body: [] }], end: -1 };
      cur.push(node);
      stack.push({ node, parent: cur });
      cur = node.branches[0]!.body;
    } else {
      const top = stack.at(-1);
      if (!top) return { text, unresolved: [`unbalanced {${kw}} on line ${k + 1}`], changed: false };
      if (kw === "END_IF") {
        top.node.end = k;
        stack.pop();
        cur = top.parent;
      } else {
        const b = { cond: kw === "ELSE" ? null : m[2]!, pragma: k, body: [] as Node[] };
        top.node.branches.push(b);
        cur = b.body;
      }
    }
  }
  if (stack.length) return { text, unresolved: ["{IF} without {END_IF}"], changed: false };

  const out = [...lines];
  const unresolved: string[] = [];
  let changed = false;
  const blank = (k: number) => {
    out[k] = "";
    changed = true;
  };
  const emit = (nodes: Node[], active: boolean) => {
    for (const n of nodes) {
      if (n.kind === "line") {
        const def = DEFINE.exec(lines[n.index]!);
        if (def) {
          // {define}/{undefine} apply from here on (in source order), and truST ignores them anyway.
          if (active) {
            if (def[1]!.toLowerCase() === "define") local.add(def[2]!.toLowerCase());
            else local.delete(def[2]!.toLowerCase());
          }
          blank(n.index);
        } else if (!active) blank(n.index);
        continue;
      }
      if (!active) {
        for (const b of n.branches) {
          blank(b.pragma);
          emit(b.body, false);
        }
        blank(n.end);
        continue;
      }
      const values = n.branches.map((b) => (b.cond === null ? true : evaluateCondition(b.cond, (x) => local.has(x.toLowerCase()), (x) => project.has(x.toLowerCase()))));
      if (values.some((v) => v === undefined)) {
        n.branches.forEach((b, j) => values[j] === undefined && unresolved.push(b.cond!));
        for (const b of n.branches) emit(b.body, true); // left for truST
        continue;
      }
      const taken = values.indexOf(true);
      n.branches.forEach((b, j) => {
        blank(b.pragma);
        emit(b.body, j === taken);
      });
      blank(n.end);
    }
  };
  emit(root, true);
  return { text: out.join("\n"), unresolved, changed };
}

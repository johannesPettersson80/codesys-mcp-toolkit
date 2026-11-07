/** Line diff (LCS) and unified-style formatting. Pure: also bundled into the panel. */

export type DiffOp = { op: " " | "+" | "-"; text: string };
/** Line diff (LCS). Falls back to remove-all/add-all for very large inputs. */
export function lineDiff(a: string, b: string): DiffOp[] {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ op: "-" as const, text: t })), ...y.map((t) => ({ op: "+" as const, text: t }))];
  const n = x.length;
  const m = y.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ op: " ", text: x[i]! });
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) ops.push({ op: "-", text: x[i++]! });
    else ops.push({ op: "+", text: y[j++]! });
  }
  while (i < n) ops.push({ op: "-", text: x[i++]! });
  while (j < m) ops.push({ op: "+", text: y[j++]! });
  return ops;
}

export const countDiff = (ops: DiffOp[]) => ({ plus: ops.filter((o) => o.op === "+").length, minus: ops.filter((o) => o.op === "-").length });

/** Unified-style hunks with line numbers of the new text and `context` lines around changes. */
export function formatDiff(ops: DiffOp[], context = 2): string[] {
  const out: string[] = [];
  let newLine = 0;
  const numbered = ops.map((o) => {
    if (o.op !== "-") newLine++;
    return { ...o, line: o.op === "-" ? undefined : newLine };
  });
  const keep = new Set<number>();
  numbered.forEach((o, k) => {
    if (o.op !== " ") for (let d = -context; d <= context; d++) keep.add(k + d);
  });
  let last = -2;
  numbered.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1 && out.length) out.push("  ...");
    out.push(`${o.op} ${o.line !== undefined ? String(o.line).padStart(4) : "    "} | ${o.text}`);
    last = k;
  });
  return out;
}


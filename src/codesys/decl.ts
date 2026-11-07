/**
 * A tolerant parser for CODESYS ST declarations: headers (kind, name,
 * EXTENDS / IMPLEMENTS, return type, modifiers), variable sections with
 * names, types, initial values, AT addresses and comments, enum members and
 * struct fields. Used for the outline and the I/O list; it never rejects
 * input, it just extracts what it recognises.
 */

export type SectionKind =
  | "VAR_INPUT"
  | "VAR_OUTPUT"
  | "VAR_IN_OUT"
  | "VAR"
  | "VAR_TEMP"
  | "VAR_STAT"
  | "VAR_INST"
  | "VAR_GLOBAL"
  | "VAR_EXTERNAL"
  | "VAR_CONFIG";

export interface VarDecl {
  name: string;
  type: string;
  init?: string;
  at?: string;
  comment?: string;
  section: SectionKind;
  constant?: boolean;
  retain?: boolean;
  persistent?: boolean;
}

export interface Header {
  keyword: string;
  name?: string;
  modifiers: string[];
  extends?: string[];
  implements?: string[];
  returnType?: string;
  attributes: string[];
}

export interface ParsedDecl {
  header: Header;
  vars: VarDecl[];
  /** Enum members with optional values (DUT enums). */
  enumMembers?: { name: string; value?: string }[];
  /** Base type of an enum (`(A, B) INT`) or an alias target. */
  baseType?: string;
  /** STRUCT / UNION fields (DUTs). */
  fields?: VarDecl[];
  dutKind?: "enum" | "struct" | "union" | "alias";
}

const SECTION_RE = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_EXTERNAL|VAR_CONFIG|VAR_TEMP|VAR_STAT|VAR_INST|VAR)\b(.*)$/i;
const MODIFIERS = new Set(["PUBLIC", "PRIVATE", "PROTECTED", "INTERNAL", "ABSTRACT", "FINAL"]);

/** Split text into statements ending in `;` outside brackets, strings and comments; keep the trailing line comment. */
function statements(text: string): { body: string; comment?: string }[] {
  const out: { body: string; comment?: string }[] = [];
  let cur = "";
  let depth = 0;
  let pendingComment: string | undefined;
  let i = 0;
  const push = () => {
    const body = cur.replace(/\s+/g, " ").trim();
    if (body) out.push({ body, ...(pendingComment ? { comment: pendingComment } : {}) });
    cur = "";
    pendingComment = undefined;
  };
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      const comment = text.slice(i + 2, end < 0 ? undefined : end).trim();
      // A comment right after `;` on the same line belongs to the previous statement.
      const last = out.at(-1);
      if (!cur.trim() && last && !last.comment && comment) last.comment = comment;
      else if (comment) pendingComment ??= comment;
      i = end < 0 ? text.length : end;
      continue;
    }
    if (two === "(*" || two === "/*") {
      const close = two === "(*" ? "*)" : "*/";
      const end = text.indexOf(close, i + 2);
      const comment = text.slice(i + 2, end < 0 ? undefined : end).trim();
      const last = out.at(-1);
      if (!cur.trim() && last && !last.comment && comment && !comment.includes("\n")) last.comment = comment;
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === "{") {
      const end = text.indexOf("}", i);
      cur += text.slice(i, end < 0 ? undefined : end + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "$" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) {
      push();
      i++;
      continue;
    }
    if (c === "\n" && depth === 0) {
      // Section keywords and headers have no `;`: end them at the line break.
      const t = cur.trim();
      // `TYPE X :` continues on the next line (the enum list or STRUCT).
      if (/^(\{[^}]*\}\s*)*TYPE\b[^;]*:\s*$/i.test(t)) cur += " ";
      else if (/^(\{[^}]*\}\s*)*(VAR\w*|END_VAR|END_STRUCT|END_UNION|END_TYPE|STRUCT|UNION|(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|TYPE)\b.*)(\s+\w+)*$/i.test(t) && !/:=/.test(t.replace(/^TYPE\b.*/i, ""))) push();
      else cur += " ";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function parseHeader(stmt: string): Header {
  const attributes = [...stmt.matchAll(/\{\s*attribute\s+'([^']+)'(?:\s*:=\s*'[^']*')?\s*\}/gi)].map((m) => m[1]!);
  const s = stmt.replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|TYPE|VAR_GLOBAL|TEST_PROGRAM|TEST_FUNCTION_BLOCK)\b\s*(.*)$/i.exec(s);
  if (!m) return { keyword: "", modifiers: [], attributes };
  const keyword = m[1]!.toUpperCase();
  let rest = m[2]!;
  const modifiers: string[] = [];
  for (;;) {
    const w = /^(\w+)\s*/.exec(rest);
    if (w && MODIFIERS.has(w[1]!.toUpperCase())) {
      modifiers.push(w[1]!.toUpperCase());
      rest = rest.slice(w[0].length);
    } else break;
  }
  const h: Header = { keyword, modifiers, attributes };
  const name = /^([A-Za-z_]\w*)/.exec(rest);
  if (name) {
    h.name = name[1]!;
    rest = rest.slice(name[0].length).trim();
  }
  const ret = /^:\s*(.+?)(?=\s+(EXTENDS|IMPLEMENTS)\b|$)/i.exec(rest);
  if (ret && keyword !== "TYPE") h.returnType = ret[1]!.trim();
  const ext = /\bEXTENDS\s+(.+?)(?=\s+IMPLEMENTS\b|$)/i.exec(rest);
  if (ext) h.extends = splitList(ext[1]!);
  const imp = /\bIMPLEMENTS\s+(.+)$/i.exec(rest);
  if (imp) h.implements = splitList(imp[1]!);
  return h;
}

function parseVar(body: string, section: SectionKind, flags: { constant: boolean; retain: boolean; persistent: boolean }, comment?: string): VarDecl[] {
  const s = body.replace(/\{[^}]*\}/g, " ").trim();
  const m = /^([A-Za-z_][\w\s,]*?)(?:\s+AT\s+(%\S+))?\s*:\s*([\s\S]+)$/i.exec(s);
  if (!m) return [];
  let type = m[3]!.trim();
  let init: string | undefined;
  // `:=` at top level separates type and initial value.
  let depth = 0;
  for (let i = 0; i < type.length - 1; i++) {
    const c = type[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === ":" && type[i + 1] === "=") {
      init = type.slice(i + 2).trim();
      type = type.slice(0, i).trim();
      break;
    }
  }
  return splitList(m[1]!).map((name) => ({
    name,
    type,
    section,
    ...(init !== undefined ? { init } : {}),
    ...(m[2] ? { at: m[2] } : {}),
    ...(comment ? { comment } : {}),
    ...(flags.constant ? { constant: true } : {}),
    ...(flags.retain ? { retain: true } : {}),
    ...(flags.persistent ? { persistent: true } : {}),
  }));
}

export function parseDeclaration(decl: string | undefined): ParsedDecl {
  const stmts = statements(decl ?? "");
  const result: ParsedDecl = { header: { keyword: "", modifiers: [], attributes: [] }, vars: [] };
  let section: SectionKind | undefined;
  let flags = { constant: false, retain: false, persistent: false };
  let inStruct: "struct" | "union" | undefined;
  for (let k = 0; k < stmts.length; k++) {
    const { body, comment } = stmts[k]!;
    const plain = body.replace(/\{[^}]*\}/g, " ").trim();
    if (!result.header.keyword) {
      const h = parseHeader(body);
      if (h.keyword) {
        result.header = h;
        if (h.keyword === "VAR_GLOBAL") {
          section = "VAR_GLOBAL";
          flags = { constant: /\bCONSTANT\b/i.test(body), retain: /\bRETAIN\b/i.test(body), persistent: /\bPERSISTENT\b/i.test(body) };
        }
        if (h.keyword === "TYPE") {
          // TYPE Name : (A := 0, B) INT  |  TYPE Name : STRUCT  |  TYPE Name : INT
          const t = /^TYPE\s+\w+\s*(?:EXTENDS\s+[\w.]+\s*)?:\s*([\s\S]*)$/i.exec(plain)?.[1]?.trim() ?? "";
          if (t.startsWith("(")) {
            const close = t.lastIndexOf(")");
            result.dutKind = "enum";
            result.enumMembers = splitList(t.slice(1, close)).map((x) => {
              const [n, v] = x.split(":=").map((y) => y.trim());
              return v !== undefined ? { name: n!, value: v } : { name: n! };
            });
            const base = t.slice(close + 1).trim();
            if (base) result.baseType = base;
          } else if (/^STRUCT\b/i.test(t)) {
            result.dutKind = "struct";
            inStruct = "struct";
            result.fields = [];
          } else if (/^UNION\b/i.test(t)) {
            result.dutKind = "union";
            inStruct = "union";
            result.fields = [];
          } else if (t) {
            result.dutKind = "alias";
            result.baseType = t;
          }
        }
        continue;
      }
    }
    const sec = SECTION_RE.exec(plain);
    if (sec) {
      section = sec[1]!.toUpperCase() as SectionKind;
      flags = { constant: /\bCONSTANT\b/i.test(sec[2]!), retain: /\bRETAIN\b/i.test(sec[2]!), persistent: /\bPERSISTENT\b/i.test(sec[2]!) };
      continue;
    }
    if (/^END_VAR\b/i.test(plain)) {
      section = undefined;
      continue;
    }
    if (/^(STRUCT|UNION)\b/i.test(plain) && result.header.keyword === "TYPE") {
      inStruct = /^STRUCT/i.test(plain) ? "struct" : "union";
      result.dutKind ??= inStruct;
      result.fields ??= [];
      continue;
    }
    if (/^END_(STRUCT|UNION|TYPE)\b/i.test(plain)) {
      inStruct = undefined;
      continue;
    }
    if (inStruct) {
      result.fields!.push(...parseVar(body, "VAR", { constant: false, retain: false, persistent: false }, comment));
      continue;
    }
    if (section) result.vars.push(...parseVar(body, section, flags, comment));
  }
  return result;
}

/** One-line signature, e.g. `METHOD Reset(bHard : BOOL) : BOOL`. */
export function signature(p: ParsedDecl, name?: string): string {
  const h = p.header;
  const ins = p.vars.filter((v) => v.section === "VAR_INPUT" || v.section === "VAR_IN_OUT").map((v) => `${v.section === "VAR_IN_OUT" ? "VAR_IN_OUT " : ""}${v.name} : ${v.type}`);
  const outs = p.vars.filter((v) => v.section === "VAR_OUTPUT").map((v) => `${v.name} : ${v.type}`);
  let s = `${name ?? h.name ?? "?"}(${ins.join(", ")}${outs.length ? `; out ${outs.join(", ")}` : ""})`;
  if (h.returnType) s += ` : ${h.returnType}`;
  return s;
}

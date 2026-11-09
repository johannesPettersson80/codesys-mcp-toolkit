/** Structured Text helpers: object kinds and declaration-header checks. */

export type ObjectKind =
  | "pou"
  | "method"
  | "property"
  | "accessor"
  | "action"
  | "dut"
  | "gvl"
  | "interface"
  | "interface_method"
  | "task_config"
  | "task"
  | "task_call"
  | "library_manager"
  | "application"
  | "folder"
  | "device"
  | "other";

export type CreateKind =
  | "program"
  | "function_block"
  | "function"
  | "method"
  | "property"
  | "action"
  | "interface"
  | "dut"
  | "gvl"
  | "folder";

export interface TreeNode {
  path: string;
  name: string;
  kind: ObjectKind;
  sub?: string;
  st?: boolean;
  depth: number;
  declaration?: string;
  implementation?: string;
  /** Build properties that are set (excluded from build also when a folder excludes it). */
  build?: { excluded?: boolean; link_always?: boolean; external?: boolean };
}

const LEAD = /^(?:\s|\{[^}]*\}|\/\/[^\n]*(?:\n|$)|\(\*[\s\S]*?\*\))*/;
const MODIFIERS = "(?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\\s+)*";
const HEADER = new RegExp(
  `^(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|TYPE|VAR_GLOBAL|VAR)\\b\\s*${MODIFIERS}([A-Za-z_][A-Za-z0-9_]*)?`,
  "i",
);

export function stripLeading(text: string): string {
  return text.replace(LEAD, "");
}

export function declarationHeader(decl: string): { keyword: string; name?: string } | undefined {
  const m = HEADER.exec(stripLeading(decl));
  if (!m) return undefined;
  const keyword = m[1]!.toUpperCase();
  const name = keyword === "VAR" || keyword === "VAR_GLOBAL" ? undefined : m[2];
  return { keyword, name };
}

const POU_KEYWORD: Record<string, string> = {
  program: "PROGRAM",
  function_block: "FUNCTION_BLOCK",
  function: "FUNCTION",
};

/**
 * Check that a new declaration keeps the object's kind and name (issue #5:
 * replacing a POU declaration without its `PROGRAM X` header silently
 * changed the POU). Returns an error message, or undefined when it's fine.
 */
export function checkDeclaration(kind: ObjectKind, sub: string | undefined, name: string, decl: string): string | undefined {
  const h = declarationHeader(decl);
  const expect = (kw: string) =>
    `The declaration of ${name} must start with '${kw} ${name}'` +
    (h ? ` (found '${h.keyword}${h.name ? " " + h.name : ""}').` : " (found no header).");
  const sameName = () => (h?.name ?? "").toLowerCase() === name.toLowerCase();
  switch (kind) {
    case "pou": {
      const kw = sub ? POU_KEYWORD[sub] : undefined;
      const allowed = kw ? [kw] : Object.values(POU_KEYWORD);
      if (!h || !allowed.includes(h.keyword) || !sameName()) {
        return expect(kw ?? "PROGRAM|FUNCTION_BLOCK|FUNCTION") + " To change a POU's type, create a new object.";
      }
      return undefined;
    }
    case "method":
    case "interface_method":
      return h?.keyword === "METHOD" && sameName() ? undefined : expect("METHOD");
    case "property":
      return h?.keyword === "PROPERTY" && sameName() ? undefined : expect("PROPERTY");
    case "interface":
      return h?.keyword === "INTERFACE" && sameName() ? undefined : expect("INTERFACE");
    case "dut":
      return h?.keyword === "TYPE" && sameName() ? undefined : expect("TYPE");
    case "gvl":
      return h?.keyword === "VAR_GLOBAL" ? undefined : `A GVL declaration must start with VAR_GLOBAL (found '${h?.keyword ?? "nothing"}').`;
    case "accessor":
      return !h || h.keyword === "VAR" ? undefined : `A property accessor declaration holds only VAR ... END_VAR (found '${h.keyword}').`;
    default:
      return undefined;
  }
}

/** Normalise CODESYS text for display/comparison. */
export function normalizeText(text: string | undefined): string | undefined {
  return text?.replace(/\r\n?/g, "\n");
}

/** Human label for a node kind. */
export function kindLabel(n: Pick<TreeNode, "kind" | "sub">): string {
  if (n.kind === "pou") return n.sub ?? "pou";
  if (n.kind === "dut") return n.sub ? `dut:${n.sub}` : "dut";
  return n.kind;
}

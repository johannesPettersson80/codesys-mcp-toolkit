/**
 * What the server knows about the open project, for the workspace panel.
 *
 * The panel must never call CODESYS itself: the bridge runs one request at a
 * time, so panel polling would stall the model's tool calls. Instead the
 * tools keep this cache current as a side effect of their own calls (open,
 * export, write, create, delete, rename, compile), and the panel reads it.
 */
import type { TreeNode } from "./st.js";

export interface CompileResult {
  at: string;
  errors: number;
  warnings: number;
  messages: { severity: string; text: string; object?: string | null; position?: string | null; code?: string }[];
}

export interface Focus {
  /** Object path the model last touched. */
  path: string;
  action: "read" | "write" | "create" | "delete" | "rename" | "revert";
  at: string;
}

export class ProjectCache {
  project?: string;
  nodes?: TreeNode[];
  /** Bumped on every change, so the panel refetches only when needed. */
  version = 0;
  compile?: CompileResult;
  focus?: Focus;

  reset(project?: string): void {
    this.project = project;
    this.nodes = undefined;
    this.compile = undefined;
    this.focus = undefined;
    this.version++;
  }

  setAll(nodes: TreeNode[]): void {
    this.nodes = nodes;
    this.version++;
  }

  /** Replace or add one object (and keep the order: new ones go after their parent's last child). */
  upsert(node: TreeNode): void {
    if (!this.nodes) return;
    const key = node.path.toLowerCase();
    const i = this.nodes.findIndex((n) => n.path.toLowerCase() === key);
    if (i >= 0) this.nodes[i] = { ...this.nodes[i]!, ...node };
    else {
      const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")).toLowerCase() : "";
      let at = this.nodes.length;
      for (let k = this.nodes.length - 1; k >= 0; k--) {
        const p = this.nodes[k]!.path.toLowerCase();
        if (p === parent || p.startsWith(parent ? parent + "/" : "")) {
          at = k + 1;
          break;
        }
      }
      this.nodes.splice(at, 0, node);
    }
    this.version++;
  }

  /** Remove an object and everything under it. */
  remove(path: string): void {
    if (!this.nodes) return;
    const key = path.toLowerCase();
    this.nodes = this.nodes.filter((n) => n.path.toLowerCase() !== key && !n.path.toLowerCase().startsWith(key + "/"));
    this.version++;
  }

  rename(path: string, newName: string): void {
    if (!this.nodes) return;
    const key = path.toLowerCase();
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const to = parent + newName;
    this.nodes = this.nodes.map((n) => {
      const p = n.path.toLowerCase();
      if (p === key) return { ...n, path: to, name: newName };
      if (p.startsWith(key + "/")) return { ...n, path: to + n.path.slice(path.length) };
      return n;
    });
    this.version++;
  }

  /** Something the workspace shows changed without a node change (e.g. the review baseline). */
  bump(): void {
    this.version++;
  }

  touch(path: string, action: Focus["action"]): void {
    this.focus = { path, action, at: new Date().toISOString() };
    this.version++;
  }

  setCompile(c: CompileResult): void {
    this.compile = c;
    this.version++;
  }

  get(path: string): TreeNode | undefined {
    const key = path.toLowerCase();
    return this.nodes?.find((n) => n.path.toLowerCase() === key);
  }
}

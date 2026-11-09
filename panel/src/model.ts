/** What the panel knows, filled by polling the app-only tools. */
import type { CompileResult, Focus } from "../../src/codesys/cache.js";
import type { PanelState } from "../../src/panel-types.js";

export interface WsNode {
  path: string;
  name: string;
  kind: string;
  sub?: string;
  depth: number;
  st?: false;
  change?: "A" | "M";
  errors?: number;
  warnings?: number;
}

export interface WsData {
  version: number;
  project: string | null;
  /** "CODESYS 3.5.22.40 · Scripting 4.2.0.0 · compiler 3.5.19.40" */
  versions?: string;
  tree: WsNode[] | null;
  removed?: string[];
  changeCount?: number;
  compile?: CompileResult | null;
  focus?: Focus | null;
}

export interface ObjText {
  declaration: string | null;
  implementation: string | null;
}

export interface ObjData {
  object: (ObjText & { path: string; name: string; kind: string; sub: string | null; st: boolean | null }) | null;
  base: ObjText | null;
  version: number;
}

export interface Model {
  state?: PanelState;
  ws?: WsData;
  objects: Map<string, ObjData>;
}

export const model: Model = { objects: new Map() };

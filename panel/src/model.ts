/** What the panel knows, filled by polling the app-only tools. */
import type { CompileResult, Focus } from "../../src/codesys/cache.js";
import type { SimEvent } from "../../src/sim/journal.js";
import type { PanelState } from "../../src/sim/panel-types.js";
import type { TrendPoint } from "../../src/sim/recorder.js";

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
  test?: true;
}

export interface WsData {
  version: number;
  project: string | null;
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

export interface Locals {
  paused: boolean;
  stack: { obj?: string; line?: number; name: string }[];
  locals: { name: string; type: string; value: string; expandable: boolean }[];
}

export interface Model {
  state?: PanelState;
  events: SimEvent[];
  trend: TrendPoint[];
  trendEpoch: number;
  ws?: WsData;
  objects: Map<string, ObjData>;
  locals?: Locals;
  values: Record<string, { value?: string; num?: number | null; error?: string }>;
}

export const model: Model = { events: [], trend: [], trendEpoch: -1, objects: new Map(), values: {} };

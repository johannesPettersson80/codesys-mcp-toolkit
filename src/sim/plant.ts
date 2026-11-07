/**
 * plant.toml: the hand-written plant for a simulation.
 *
 * It names truST plant models and wires their channels to ST variables by
 * name (truST itself wires by %I/%Q address only, TRUST-GAPS B10; the mirror
 * generates the addresses). It can also describe simple discrete feedback
 * (valve limit switches, pump running) that the mirror simulates in ST.
 *
 *   [simulation]
 *   seed = 42                 # optional
 *   plant_step_ms = 10        # optional
 *
 *   [[plant]]
 *   id = "T101"
 *   model = "gravity_tank"
 *   inputs = ["GVL_IO.lrFV101_FlowCmd"]   # PLC -> plant command channels, in order
 *   outputs = ["GVL_IO.lrLT101_Level"]    # plant feedback channels -> PLC, in order
 *   initial_state = [0.2]
 *   [plant.parameters]
 *   area_m2 = 1.0
 *   outflow_coefficient_m2_sqrt_m_per_s = 0.03
 *   display = { max = 2.5, unit = "m" }   # optional, for the panel only
 *   # any other truST plant keys (actuator, noise, events, ...) pass through unchanged
 *
 *   [[feedback]]
 *   signal = "GVL_IO.xXV101_Opened"       # BOOL the simulation drives
 *   follows = "GVL_IO.xXV101_Open"        # BOOL it follows
 *   delay_ms = 2000                       # optional on/off delay (e.g. valve stroke time)
 *   invert = false                        # optional
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export interface PlantDef {
  id: string;
  model: string;
  inputs: string[];
  outputs: string[];
  initial_state?: number[];
  parameters?: Record<string, unknown>;
  /** Panel hints (not passed to truST): scale and unit of the first output. */
  display?: PlantDisplay;
  /** Other truST plant keys, passed through to simulation.toml. */
  extra: Record<string, unknown>;
}

export interface PlantDisplay {
  max?: number;
  min?: number;
  unit?: string;
  label?: string;
}

export interface FeedbackDef {
  signal: string;
  follows: string;
  delay_ms: number;
  invert: boolean;
}

export interface PlantConfig {
  seed?: number;
  plant_step_ms?: number;
  plants: PlantDef[];
  feedback: FeedbackDef[];
}

export class PlantConfigError extends Error {}

const VAR_PATH = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function strList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new PlantConfigError(`${what} must be a list of variable names`);
  for (const s of v as string[]) {
    if (!VAR_PATH.test(s)) throw new PlantConfigError(`${what}: '${s}' is not a variable path like GVL_IO.lrLevel or PRG_Tank.rValue`);
  }
  return v as string[];
}

export function parsePlantConfig(text: string): PlantConfig {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new PlantConfigError(`plant.toml is not valid TOML: ${(e as Error).message}`);
  }
  for (const k of Object.keys(doc)) {
    if (!["simulation", "plant", "feedback"].includes(k)) throw new PlantConfigError(`unknown section [${k}] (expected [simulation], [[plant]], [[feedback]])`);
  }
  const sim = (doc.simulation ?? {}) as Record<string, unknown>;
  const cfg: PlantConfig = { plants: [], feedback: [] };
  if (sim.seed !== undefined) cfg.seed = Number(sim.seed);
  if (sim.plant_step_ms !== undefined) cfg.plant_step_ms = Number(sim.plant_step_ms);

  const plants = (doc.plant ?? []) as Record<string, unknown>[];
  if (!Array.isArray(plants)) throw new PlantConfigError("use [[plant]] (an array of tables) for plants");
  const ids = new Set<string>();
  for (const p of plants) {
    const { id, model, inputs, outputs, initial_state, parameters, command_sources, feedback_targets, display, ...extra } = p;
    if (typeof id !== "string" || !ID.test(id)) throw new PlantConfigError("every [[plant]] needs an id (letters, digits, _ or -)");
    if (ids.has(id)) throw new PlantConfigError(`duplicate plant id '${id}'`);
    ids.add(id);
    if (typeof model !== "string" || !model) throw new PlantConfigError(`plant ${id}: model is required (e.g. "gravity_tank")`);
    if (command_sources !== undefined || feedback_targets !== undefined) {
      throw new PlantConfigError(`plant ${id}: use inputs/outputs with variable names; the mirror generates command_sources/feedback_targets`);
    }
    const def: PlantDef = { id, model, inputs: strList(inputs, `plant ${id} inputs`), outputs: strList(outputs, `plant ${id} outputs`), extra };
    if (initial_state !== undefined) {
      if (!Array.isArray(initial_state) || initial_state.some((x) => typeof x !== "number")) throw new PlantConfigError(`plant ${id}: initial_state must be a list of numbers`);
      def.initial_state = initial_state as number[];
    }
    if (parameters !== undefined) {
      if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) throw new PlantConfigError(`plant ${id}: [plant.parameters] must be a table`);
      def.parameters = parameters as Record<string, unknown>;
    }
    if (display !== undefined) {
      if (typeof display !== "object" || display === null || Array.isArray(display)) throw new PlantConfigError(`plant ${id}: display must be a table, e.g. display = { max = 2.5, unit = "m" }`);
      const d = display as Record<string, unknown>;
      for (const k of Object.keys(d)) if (!["max", "min", "unit", "label"].includes(k)) throw new PlantConfigError(`plant ${id}: unknown display key '${k}' (max, min, unit, label)`);
      def.display = {
        ...(typeof d.max === "number" ? { max: d.max } : {}),
        ...(typeof d.min === "number" ? { min: d.min } : {}),
        ...(typeof d.unit === "string" ? { unit: d.unit } : {}),
        ...(typeof d.label === "string" ? { label: d.label } : {}),
      };
    }
    cfg.plants.push(def);
  }

  const fbs = (doc.feedback ?? []) as Record<string, unknown>[];
  if (!Array.isArray(fbs)) throw new PlantConfigError("use [[feedback]] (an array of tables) for feedback");
  for (const f of fbs) {
    if (typeof f.signal !== "string" || !VAR_PATH.test(f.signal)) throw new PlantConfigError("every [[feedback]] needs signal = \"GVL.var\"");
    if (typeof f.follows !== "string" || !VAR_PATH.test(f.follows)) throw new PlantConfigError(`feedback ${f.signal}: follows = "GVL.var" is required`);
    const delay = f.delay_ms === undefined ? 0 : Number(f.delay_ms);
    if (!Number.isFinite(delay) || delay < 0) throw new PlantConfigError(`feedback ${f.signal}: delay_ms must be >= 0`);
    for (const k of Object.keys(f)) {
      if (!["signal", "follows", "delay_ms", "invert"].includes(k)) throw new PlantConfigError(`feedback ${f.signal}: unknown key '${k}'`);
    }
    cfg.feedback.push({ signal: f.signal, follows: f.follows, delay_ms: Math.round(delay), invert: f.invert === true });
  }

  const used = new Map<string, string>();
  const claim = (v: string, by: string) => {
    const k = v.toLowerCase();
    if (used.has(k)) throw new PlantConfigError(`${v} is wired twice (${used.get(k)} and ${by})`);
    used.set(k, by);
  };
  for (const p of cfg.plants) {
    p.outputs.forEach((v) => claim(v, `plant ${p.id} output`));
  }
  for (const f of cfg.feedback) claim(f.signal, `feedback`);
  return cfg;
}

/** A plant parameter override, applied to the generated simulation.toml only. */
export interface ParamOverride {
  plant: string;
  /** Dotted key inside the plant table, e.g. "parameters.area_m2" or "initial_state". */
  key: string;
  value: unknown;
}

export function applyOverride(cfg: PlantConfig, o: ParamOverride): void {
  const p = cfg.plants.find((x) => x.id.toLowerCase() === o.plant.toLowerCase());
  if (!p) throw new PlantConfigError(`no plant '${o.plant}' (plants: ${cfg.plants.map((x) => x.id).join(", ") || "none"})`);
  const parts = o.key.split(".");
  if (parts[0] === "inputs" || parts[0] === "outputs" || parts[0] === "id" || parts[0] === "model") {
    throw new PlantConfigError(`'${parts[0]}' can't be overridden; edit plant.toml`);
  }
  if (parts.length === 1 && parts[0] === "initial_state") {
    p.initial_state = o.value as number[];
    return;
  }
  // Short form: a bare name that is a model parameter.
  if (parts.length === 1 && (p.parameters?.[parts[0]!] !== undefined || !(parts[0]! in p.extra))) {
    p.parameters = { ...(p.parameters ?? {}), [parts[0]!]: o.value };
    return;
  }
  let target: Record<string, unknown> = parts[0] === "parameters" ? (p.parameters ??= {}) : p.extra;
  const path = parts[0] === "parameters" ? parts.slice(1) : parts;
  for (const seg of path.slice(0, -1)) {
    const next = target[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) target[seg] = {};
    target = target[seg] as Record<string, unknown>;
  }
  target[path[path.length - 1]!] = o.value;
}

export interface SimulationTomlOptions {
  timeScale: number;
  traceCapacity: number;
  /** Address per variable path (lower-case key), from the mirror. */
  addresses: Map<string, string>;
}

export function simulationToml(cfg: PlantConfig | undefined, o: SimulationTomlOptions): string {
  const doc: Record<string, unknown> = {
    simulation: {
      enabled: true,
      seed: cfg?.seed ?? 42,
      time_scale: o.timeScale,
      plant_step_ms: cfg?.plant_step_ms ?? 10,
      plant_trace_capacity: o.traceCapacity,
    },
  };
  if (cfg?.plants.length) {
    doc.plants = cfg.plants.map((p) => {
      const addr = (v: string) => {
        const a = o.addresses.get(v.toLowerCase());
        if (!a) throw new PlantConfigError(`no address for ${v}`);
        return a;
      };
      const t: Record<string, unknown> = {
        id: p.id,
        model: p.model,
        command_sources: p.inputs.map(addr),
        feedback_targets: p.outputs.map(addr),
      };
      if (p.initial_state) t.initial_state = p.initial_state;
      Object.assign(t, p.extra);
      if (p.parameters) t.parameters = p.parameters;
      return t;
    });
  }
  return stringifyToml(doc) + "\n";
}

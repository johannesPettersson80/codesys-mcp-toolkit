/**
 * Scenarios: saved experiments with expectations, kept next to the project
 * in `<Project>.scenarios.toml` and rerun after every change.
 *
 *   [[scenario]]
 *   name = "level step"
 *   duration_s = 300
 *   pv = "GVL_IO.lrLT101_Level"
 *   sp = { var = "GVL_Par.rLevelSP", value = 1.2, at_s = 10 }
 *   watch = ["PRG_Tank.nTrips"]
 *   [scenario.expect]
 *   overshoot_pct = { max = 5 }
 *   settling_time_s = { max = 200 }
 *   "PRG_Tank.nTrips" = { final = 0 }
 *
 * Expectations on metrics (overshoot_pct, rise_time_s, settling_time_s,
 * steady_state_error, iae, pv_min, pv_max, pv_final) take min, max, abs_max
 * or equals. Expectations on watched variables take final, min and max
 * (over the whole run).
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { ExperimentSpec } from "./controller.js";

export interface Bound {
  min?: number;
  max?: number;
  abs_max?: number;
  equals?: number | string;
  final?: number | string;
}

export interface Scenario extends ExperimentSpec {
  name: string;
  expect?: Record<string, Bound>;
}

export class ScenarioError extends Error {}

const SPEC_KEYS = new Set(["name", "duration_s", "speed", "pv", "sp", "set", "force", "watch", "samples", "restart", "expect"]);
const BOUND_KEYS = new Set(["min", "max", "abs_max", "equals", "final"]);

export function parseScenarios(text: string): Scenario[] {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new ScenarioError(`scenarios file is not valid TOML: ${(e as Error).message}`);
  }
  const list = (doc.scenario ?? []) as Record<string, unknown>[];
  if (!Array.isArray(list)) throw new ScenarioError("use [[scenario]] (an array of tables)");
  const names = new Set<string>();
  return list.map((s) => validateScenario(s, names));
}

export function validateScenario(s: Record<string, unknown>, names = new Set<string>()): Scenario {
  if (typeof s.name !== "string" || !s.name.trim()) throw new ScenarioError("every scenario needs a name");
  const key = s.name.toLowerCase();
  if (names.has(key)) throw new ScenarioError(`duplicate scenario '${s.name}'`);
  names.add(key);
  for (const k of Object.keys(s)) if (!SPEC_KEYS.has(k)) throw new ScenarioError(`scenario '${s.name}': unknown key '${k}'`);
  if (!(typeof s.duration_s === "number" && s.duration_s > 0)) throw new ScenarioError(`scenario '${s.name}': duration_s must be a positive number`);
  const expect = (s.expect ?? {}) as Record<string, Record<string, unknown>>;
  for (const [k, b] of Object.entries(expect)) {
    if (typeof b !== "object" || b === null) throw new ScenarioError(`scenario '${s.name}': expect.${k} must be a table like { max = 5 }`);
    for (const bk of Object.keys(b)) if (!BOUND_KEYS.has(bk)) throw new ScenarioError(`scenario '${s.name}': expect.${k}: unknown bound '${bk}' (min, max, abs_max, equals, final)`);
  }
  return s as unknown as Scenario;
}

export function stringifyScenarios(list: Scenario[]): string {
  const clean = list.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
  return `# Saved simulation scenarios (codesys-mcp-toolkit). Run them with run_scenarios.\n${stringifyToml({ scenario: clean })}\n`;
}

export interface Check {
  key: string;
  ok: boolean;
  text: string;
}

/** Check a run's metrics and watched-variable statistics against the expectations. */
export function checkExpectations(
  expect: Record<string, Bound> | undefined,
  metrics: Record<string, number | string | null>,
  watch: Record<string, { final: number | null; finalText: string; min: number | null; max: number | null }>,
): Check[] {
  const out: Check[] = [];
  for (const [key, b] of Object.entries(expect ?? {})) {
    const w = watch[key];
    const val = (which: "final" | "min" | "max" | "metric"): number | string | null | undefined => {
      if (which === "metric") return w ? w.final : metrics[key];
      return w ? w[which] : undefined;
    };
    const fails: string[] = [];
    const show = (v: unknown) => (v === null || v === undefined ? (key === "settling_time_s" ? "not settled" : "n/a") : String(v));
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    if (!w && !(key in metrics)) {
      out.push({ key, ok: false, text: `${key}: no such metric or watched variable (add it to watch)` });
      continue;
    }
    const subject = val("metric");
    if (b.min !== undefined) {
      const v = w ? w.min : num(subject);
      if (v === null || v === undefined || v < b.min) fails.push(`${w ? "min " : ""}${show(v)} < min ${b.min}`);
    }
    if (b.max !== undefined) {
      const v = w ? w.max : num(subject);
      if (v === null || v === undefined || v > b.max) fails.push(`${w ? "max " : ""}${show(v)} > max ${b.max}`);
    }
    if (b.abs_max !== undefined) {
      const v = num(subject);
      if (v === null || Math.abs(v) > b.abs_max) fails.push(`|${show(v)}| > ${b.abs_max}`);
    }
    for (const eq of [b.equals, b.final]) {
      if (eq === undefined) continue;
      const got = w ? (typeof eq === "number" ? w.final : w.finalText) : subject;
      const same = typeof eq === "number" ? typeof got === "number" && Math.abs(got - eq) < 1e-9 : String(got).toUpperCase() === String(eq).toUpperCase();
      if (!same) fails.push(`${w ? "final " : ""}${show(got)} ≠ ${eq}`);
    }
    const now = w ? `final ${w.finalText}${w.min !== null ? `, range ${w.min}…${w.max}` : ""}` : show(subject);
    out.push({ key, ok: fails.length === 0, text: fails.length ? `${key}: ${fails.join("; ")}` : `${key}: ${now} ok` });
  }
  return out;
}

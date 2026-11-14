/**
 * Unit tests in CODESYS's simulation: test cases of steps (write or force
 * inputs, run cycles or wait, check values), run in order, reported as a table.
 */
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import { plcValue } from "../hmi/value.js";
import type { AppContext } from "../tools.js";
import { currentCodesysSim } from "./simulation.js";

const expectation = z.union([
  z.string().describe("Exact value: 'TRUE', '42', 'T#2S'"),
  z.object({ op: z.enum(["=", "<>", "<", "<=", ">", ">="]), value: z.number(), tolerance: z.number().optional() }),
]);

export const testSchema = z.object({
  cases: z
    .array(
      z.object({
        name: z.string(),
        steps: z
          .array(
            z.object({
              write: z.record(z.string(), z.string()).optional().describe("Write values once"),
              force: z.record(z.string(), z.string()).optional().describe("Force values (held until unforced)"),
              unforce: z.array(z.string()).optional(),
              cycles: z.number().int().min(1).max(10_000).optional().describe("Run exactly n cycles (the simulation is stopped between steps)"),
              waitMs: z.number().int().min(1).max(60_000).optional().describe("Let it run for this long"),
              expect: z.record(z.string(), expectation).optional().describe("Values to check after the step"),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

type Expectation = z.infer<typeof expectation>;

/** Whether a read value meets an expectation; booleans and numbers compare by value. */
export function check(raw: string | undefined, exp: Expectation): boolean {
  const got = plcValue(raw);
  if (typeof exp === "string") {
    const want = plcValue(exp);
    if (typeof got === "number" && typeof want === "number") return Math.abs(got - want) < 1e-9;
    return String(got).toLowerCase() === String(want).toLowerCase();
  }
  const n = typeof got === "boolean" ? (got ? 1 : 0) : typeof got === "number" ? got : NaN;
  if (Number.isNaN(n)) return false;
  const t = exp.tolerance ?? 0;
  switch (exp.op) {
    case "=":
      return Math.abs(n - exp.value) <= t;
    case "<>":
      return Math.abs(n - exp.value) > t;
    case "<":
      return n < exp.value;
    case "<=":
      return n <= exp.value + t;
    case ">":
      return n > exp.value;
    case ">=":
      return n >= exp.value - t;
  }
}

const show = (e: Expectation) => (typeof e === "string" ? e : `${e.op} ${e.value}${e.tolerance ? ` ±${e.tolerance}` : ""}`);

export function registerSimTestAction(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const b = ctx.bridge;
  reg(
    "codesys_sim_test",
    {
      description:
        "Run test cases in CODESYS's simulation and get a pass/fail report. Each case is a list of steps: write or force inputs, run exact cycles or wait (real time), then expect values ('TRUE', '42', or {op: '>=', value: 10, tolerance?}). Cases run in order on the same running application, so reset what a case changes. Start the simulation first (codesys_sim_start). Use it to prove logic (latches, interlocks, timers, sequences) before building an HMI.",
      inputSchema: testSchema,
    },
    async ({ cases }) =>
      run(async () => {
        if (!currentCodesysSim(ctx)) throw new Error("The simulation isn't running: call codesys_sim_start first.");
        const rows: string[] = [];
        let passed = 0, failed = 0;
        for (const tc of cases) {
          let ok = true;
          const notes: string[] = [];
          for (const [k, st] of tc.steps.entries()) {
            if (st.unforce?.length) await b.call("sim.unforce", { names: st.unforce });
            if (st.force) await b.call("sim.force", { values: st.force });
            if (st.write) await b.call("sim.write", { values: st.write });
            if (st.cycles) await b.call("sim.cycle", { count: st.cycles }, { timeoutMs: Math.max(60_000, st.cycles * 1_000) });
            if (st.waitMs) {
              await b.call("sim.control", { action: "run" });
              await new Promise((r) => setTimeout(r, st.waitMs));
            }
            if (st.expect) {
              const names = Object.keys(st.expect);
              const r = await b.call<{ values: Record<string, string>; errors: Record<string, string> }>("sim.read", { names });
              for (const n of names) {
                const exp = st.expect[n]!;
                const got = r.values[n] ?? (r.errors[n] ? `error: ${r.errors[n]}` : undefined);
                if (!check(r.values[n], exp)) {
                  ok = false;
                  notes.push(`step ${k + 1}: ${n} = ${got ?? "?"}, expected ${show(exp)}`);
                }
              }
            }
          }
          ok ? passed++ : failed++;
          rows.push(`| ${tc.name} | ${ok ? "PASS" : "FAIL"} | ${notes.join("; ") || "all expectations met"} |`);
        }
        return [`${passed} passed, ${failed} failed.`, "", "| Test | Result | Details |", "| --- | --- | --- |", ...rows].join("\n");
      }),
  );
}

/**
 * The live side of an HMI screen, in the browser: applies PLC values to a
 * mounted screen (render.ts) and turns clicks into writes. No dependencies
 * besides value.ts, so the page bundle stays small.
 */
import type { Binding } from "../../src/hmi/render.js";
import { plcValue } from "../../src/hmi/value.js";

export type Values = Record<string, string | undefined>;
export type Write = (variable: string, value: string) => void;

export interface LiveScreen {
  update(values: Values, sim?: { state?: string }): void;
  destroy(): void;
}

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : typeof x === "boolean" ? (x ? 1 : 0) : undefined);
const truthy = (x: unknown) => x === true || (typeof x === "number" && x !== 0);

function fmt(x: unknown, decimals?: number): string {
  if (typeof x === "boolean") return x ? "ON" : "OFF";
  if (typeof x === "number") {
    const d = decimals ?? (Number.isInteger(x) ? 0 : Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2);
    return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  return x === undefined ? "–" : String(x);
}

function toneFor(x: number | undefined, bands?: { from: number; tone: string }[]): string | undefined {
  if (x === undefined || !bands?.length) return undefined;
  let t: string | undefined;
  for (const b of [...bands].sort((a, c) => a.from - c.from)) if (x >= b.from) t = b.tone;
  return t;
}

/** Value history per variable, kept across page changes so trends don't restart. */
const history = new Map<string, { t: number; v: number }[]>();

export function mountLive(root: HTMLElement, bindings: Binding[], send: Write, navigate?: (page: string) => void): LiveScreen {
  // Show a write at once, so a second click builds on it before the next poll.
  const write: Write = (variable, value) => {
    send(variable, value);
    update({ [variable]: value });
  };
  const els = new Map<number, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>("[data-b]").forEach((el) => {
    const i = Number(el.dataset.b);
    els.set(i, [...(els.get(i) ?? []), el]);
  });
  let last: Values = {};
  const now = () => Date.now();

  const val = (v: string) => plcValue(last[v]);

  // Clicks: buttons, switches, setpoints.
  const onDown = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || !root.contains(el)) return;
    const v = el.dataset.var!;
    const act = el.dataset.act;
    if (act === "tap") {
      write(v, "TRUE");
      const up = () => {
        write(v, "FALSE");
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    } else if (act === "toggle") write(v, truthy(val(v)) ? "FALSE" : "TRUE");
    else if (act === "set") write(v, "TRUE");
    else if (act === "reset") write(v, "FALSE");
    e.preventDefault();
  };
  const spWrite = (sp: HTMLElement, n: number) => {
    const min = Number(sp.dataset.min), max = Number(sp.dataset.max), step = Number(sp.dataset.step) || 1;
    const c = Math.min(max, Math.max(min, Math.round(n / step) * step));
    write(sp.dataset.var!, String(Number(c.toFixed(6))));
  };
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const nav = t.closest<HTMLElement>("[data-nav]");
    if (nav) return navigate?.(nav.dataset.nav!);
    const open = t.closest<Element>("[data-open]");
    if (open) {
      root.querySelector<HTMLElement>(`#${open.getAttribute("data-open")}`)?.removeAttribute("hidden");
      return;
    }
    if (t.closest("[data-close]") || t.classList.contains("fp")) {
      t.closest<HTMLElement>(".fp")?.setAttribute("hidden", "");
      return;
    }
    const b = t.closest<HTMLElement>(".sp-btn");
    if (!b) return;
    const sp = b.closest<HTMLElement>(".sp")!;
    const cur = num(val(sp.dataset.var!)) ?? Number(sp.dataset.min);
    spWrite(sp, cur + Number(b.dataset.step) * (Number(sp.dataset.step) || 1));
  };
  const onChange = (e: Event) => {
    const r = e.target as HTMLInputElement;
    if (!r.classList.contains("sp-range")) return;
    spWrite(r.closest<HTMLElement>(".sp")!, Number(r.value));
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);

  const clock = root.querySelector<HTMLElement>("[data-clock]");
  const tick = () => clock && (clock.textContent = new Date().toLocaleTimeString("en-GB"));
  tick();
  const timer = setInterval(tick, 1000);

  function drawLine(svg: SVGSVGElement, paths: SVGPathElement[], series: { t: number; v: number }[][], seconds: number, lo?: number, hi?: number, fill?: SVGPathElement) {
    const vb = svg.viewBox.baseVal;
    const t1 = now(), t0 = t1 - seconds * 1000;
    const all = series.flat().filter((p) => p.t >= t0).map((p) => p.v);
    let min = lo ?? Math.min(...all), max = hi ?? Math.max(...all);
    if (!all.length) return { min: 0, max: 0 };
    if (max - min < 1e-9) (min -= 1), (max += 1);
    const pad = (max - min) * 0.08;
    if (lo === undefined) min -= pad;
    if (hi === undefined) max += pad;
    series.forEach((pts, i) => {
      const d = pts
        .filter((p) => p.t >= t0)
        .map((p, k) => `${k ? "L" : "M"}${(((p.t - t0) / (t1 - t0)) * vb.width).toFixed(1)} ${(vb.height - ((p.v - min) / (max - min)) * vb.height).toFixed(1)}`)
        .join(" ");
      paths[i]?.setAttribute("d", d);
      if (fill && i === 0 && d) fill.setAttribute("d", `${d} L${vb.width} ${vb.height} L0 ${vb.height} Z`.replace(/^M[\d.]+/, (m) => m));
    });
    return { min, max };
  }

  // An optimistic write passes no simulation state: keep the last one (else the header blinks "Offline").
  let simNow: { state?: string } | undefined;
  function update(values: Values, sim: { state?: string } | undefined = simNow) {
    simNow = sim;
    last = { ...last, ...values };
    const t = now();
    for (const [k, raw] of Object.entries(values)) {
      const n = num(plcValue(raw));
      if (n === undefined) continue;
      const h = history.get(k) ?? [];
      h.push({ t, v: n });
      while (h.length && h[0]!.t < t - 3_600_000) h.shift();
      history.set(k, h);
    }
    els.forEach((list, i) => {
      const b = bindings[i];
      if (!b) return;
      for (const el of list) apply(el, b);
    });
    root.querySelectorAll<HTMLElement>(".alarms").forEach((ul) => ul.classList.toggle("has", !!ul.querySelector(".al.active")));
    const s = root.querySelector<HTMLElement>("[data-sim]");
    if (s) {
      const st = sim?.state;
      const running = st === "run";
      s.classList.toggle("run", running);
      s.classList.toggle("stop", !!st && !running);
      s.querySelector(".lbl")!.textContent = running ? "Simulation running" : st ? `Simulation ${st}` : "Offline";
    }
  }

  function apply(el: HTMLElement, b: Binding) {
    switch (b.kind) {
      case "text": {
        const x = "v" in b ? val(b.v) : undefined;
        el.textContent = fmt(x, b.decimals) + (b.unit && x !== undefined ? ` ${b.unit}` : "");
        const tone = toneFor(num(x), b.bands);
        if (tone) el.dataset.tone = tone;
        else delete el.dataset.tone;
        break;
      }
      case "on":
        el.classList.toggle("on", truthy(val(b.v)) !== !!b.invert);
        break;
      case "fault":
        el.classList.toggle("fault", truthy(val(b.v)));
        break;
      case "alarm":
        el.classList.toggle("active", truthy(val(b.v)));
        break;
      case "count": {
        const n = b.vars.filter((v) => truthy(val(v))).length;
        el.classList.toggle("on", n > 0);
        const num = el.querySelector(".n");
        if (num) num.textContent = String(n);
        const lbl = el.querySelector(".lbl");
        if (lbl) lbl.textContent = n === 1 ? "alarm" : "alarms";
        break;
      }
      case "level": {
        const n = num(val(b.v));
        const p = n === undefined ? 0 : Math.min(1, Math.max(0, (n - b.min) / (b.max - b.min || 1)));
        el.style.setProperty("--p", p.toFixed(4));
        const tone = toneFor(n, b.bands);
        if (tone) el.dataset.tone = tone;
        else delete el.dataset.tone;
        break;
      }
      case "setpoint": {
        const r = el.querySelector<HTMLInputElement>(".sp-range");
        const n = num(val(b.v));
        if (r && n !== undefined && document.activeElement !== r) r.value = String(n);
        break;
      }
      case "spark": {
        const svg = el as unknown as SVGSVGElement;
        drawLine(svg, [svg.querySelector<SVGPathElement>(".spark-line")!], [history.get(b.v) ?? []], 60, undefined, undefined, svg.querySelector<SVGPathElement>(".spark-fill")!);
        break;
      }
      case "trend": {
        const svg = el as unknown as SVGSVGElement;
        const r = drawLine(svg, [...svg.querySelectorAll<SVGPathElement>(".tr-line")], b.series.map((s) => history.get(s) ?? []), b.seconds, b.min, b.max);
        const axis = svg.parentElement?.querySelector(".tr-axis");
        if (axis) {
          axis.querySelector(".tr-max")!.textContent = fmt(r.max);
          axis.querySelector(".tr-min")!.textContent = fmt(r.min);
        }
        break;
      }
    }
  }

  return {
    update,
    destroy() {
      clearInterval(timer);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
    },
  };
}

/** Seed history so a screenshot shows trends and sparklines (values drift around the given ones). */
export function seedHistory(live: LiveScreen, values: Values, seconds = 60) {
  const t0 = Date.now();
  const realNow = Date.now;
  for (let i = 30; i >= 1; i--) {
    const at = t0 - (i * seconds * 1000) / 30;
    Date.now = () => at;
    const v: Values = {};
    for (const [k, raw] of Object.entries(values)) {
      const n = plcValue(raw);
      v[k] = typeof n === "number" ? String(n * (1 + 0.08 * Math.sin(i / 3) + 0.03 * Math.cos(i * 1.7))) : raw;
    }
    live.update(v);
  }
  Date.now = realNow;
  live.update(values);
}

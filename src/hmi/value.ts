/** Parsing PLC values; no dependencies, so the browser page can use it too. */
/** A PLC value as the simulation reports it ("TRUE", "INT#8", "REAL#1.5", "T#1s"), as a number or boolean. */
export function plcValue(raw: string | undefined): number | boolean | string | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  const typed = /^[A-Z_]+#(.*)$/i.exec(s);
  const body = typed ? typed[1]! : s;
  if (/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(body)) return Number(body);
  const time = /^(?:T|TIME|LTIME)#(.+)$/i.exec(s);
  if (time) {
    let ms = 0;
    for (const m of time[1]!.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)) {
      const n = Number(m[1]);
      ms += { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 }[m[2]!.toLowerCase() as "d"]! * n;
    }
    return ms;
  }
  return s;
}

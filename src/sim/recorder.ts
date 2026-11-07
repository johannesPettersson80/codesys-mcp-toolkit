/**
 * Trend recorder: numeric samples of the simulation's signals against
 * simulated time, for the panel's trend strip.
 *
 * Each fresh start of the runtime begins a new epoch (simulated time starts
 * over), so the panel can tell a restart from time going backwards. Samples
 * come from the end of each run, every experiment sample, and live panel
 * polls while the simulation runs freely.
 */

export interface TrendPoint {
  /** Simulated time in seconds since the start of the epoch. */
  t: number;
  values: Record<string, number | null>;
}

export class Recorder {
  epoch = 0;
  private points: TrendPoint[] = [];

  constructor(private readonly capacity = 20_000) {}

  /** Start a new epoch (the runtime restarted). */
  reset(): void {
    this.epoch++;
    this.points = [];
  }

  add(t: number, values: Record<string, number | null>): void {
    const last = this.points.at(-1);
    if (last && t < last.t) return; // stale sample from before a restart
    if (last && t === last.t) {
      Object.assign(last.values, values);
      return;
    }
    this.points.push({ t, values: { ...values } });
    if (this.points.length > this.capacity) {
      // Keep the newest half at full resolution and thin out the older half.
      const keep = this.points.slice(-Math.floor(this.capacity / 2));
      const old = this.points.slice(0, this.points.length - keep.length).filter((_, i) => i % 2 === 0);
      this.points = [...old, ...keep];
    }
  }

  /** Points after simulated time `t` in this epoch (all of them if epoch differs). */
  since(epoch: number, t: number, limit = 2000): { epoch: number; points: TrendPoint[]; reset: boolean } {
    if (epoch !== this.epoch) return { epoch: this.epoch, points: this.points.slice(-limit), reset: true };
    const i = this.points.findIndex((p) => p.t > t);
    return { epoch: this.epoch, points: i < 0 ? [] : this.points.slice(i, i + limit), reset: false };
  }

  get size(): number {
    return this.points.length;
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** Toggle aria-pressed on a segmented control and return the selected key. */
export function segmented(id: string, onChange: (key: string) => void): void {
  const seg = $(id);
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b?.dataset.t) return;
    for (const x of seg.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    onChange(b.dataset.t);
  });
}

export function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

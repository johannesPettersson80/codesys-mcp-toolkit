/**
 * The HMI design system: one set of tokens for the browser screen (render.ts)
 * and the native CODESYS visualization (native.ts), so both look the same.
 *
 * The light and dark themes take their colours from Siemens iX (Classic light / Classic dark,
 * @siemens/ix 5.3, MIT), the open-source design system behind WinCC Unified, and follow its rules:
 * - surfaces are calm and flat (no glow, no gradients); colour means something:
 *   a machine state, an alarm, a live value against its limits, or the action to take;
 * - one primary colour for what the operator can act on (current page, the one primary button);
 * - status colours (ok, warn, alarm) only on icons, indicators and fills, never on text
 *   ("they would not meet the minimum required contrast", iX colour guide);
 * - five tones for state: ok (running), warn, alarm, accent (manual, info) and neutral (off).
 * Pure: no DOM.
 */
import { darkTextOn } from "./color.js";

export type ThemeName = "light" | "dark" | "contrast";
export type ToneName = "accent" | "ok" | "warn" | "alarm" | "neutral";

export interface Theme {
  dark: boolean;
  /** Page background, behind the cards. */
  bg: string;
  /** Cards, the top bar and the navigation rail. */
  surface: string;
  /** Fields and controls inside a card (segmented switch, set-point field). */
  surface2: string;
  /** Card borders and dividers. */
  line: string;
  /** Values and main text. */
  text: string;
  /** Titles and labels. */
  text2: string;
  /** Units, limits and other quiet text. */
  text3: string;
  /** The empty part of bars, gauges and switches. */
  track: string;
  /** Borders of controls: outlined buttons, fields (iX std-bdr). */
  ctl: string;
  tones: Record<ToneName, string>;
  /** Process drawings (pipes, liquid, equipment). */
  pipe: string;
  liquid: string;
  /**
   * Equipment's fill: the surface whatever its state (state has its own signs: a run sign by the
   * name, a mode hand, a condition badge; a closed valve is drawn filled in the line colour).
   */
  equip: string;
  equipOn: string;
  /** Lines on stopped equipment (and outlines generally), and on running equipment. */
  equipLine: string;
  equipLineOn: string;
  /** Trend lines, in order. */
  series: string[];
}

export const THEMES: Record<ThemeName, Theme> = {
  light: {
    dark: false,
    // iX Classic light: color-2 page, color-1 cards, color-3 track, soft/std text and soft border on white.
    bg: "#eff0f1",
    surface: "#ffffff",
    surface2: "#f5f6f6",
    line: "#d5d8db",
    text: "#1a232d",
    text2: "#5c636a",
    text3: "#80868c",
    track: "#e2e4e6",
    ctl: "#b3b9bf",
    tones: { accent: "#006e93", ok: "#2c8500", warn: "#ffbb00", alarm: "#d72332", neutral: "#66727e" },
    pipe: "#92979b",
    liquid: "#9cc2e0",
    equip: "#ffffff",
    equipOn: "#ffffff",
    equipLine: "#1a232d",
    equipLineOn: "#1a232d",
    series: ["#1565c0", "#d9730d", "#7b4fc9", "#13897b", "#c2185b", "#6d7d1a"],
  },
  dark: {
    dark: true,
    // iX Classic dark: color-1 page, cards between color-1 and color-2, color-2 fields and track.
    bg: "#0f1619",
    surface: "#1b2428",
    surface2: "#283236",
    line: "#35424a",
    text: "#e0e7ea",
    text2: "#9faeb5",
    text3: "#7f8d94",
    track: "#283236",
    ctl: "#6a7a82",
    tones: { accent: "#00bde3", ok: "#44cc00", warn: "#ffbb00", alarm: "#ff2453", neutral: "#94a1a9" },
    pipe: "#63737b",
    liquid: "#3d6f94",
    equip: "#1b2428",
    equipOn: "#1b2428",
    equipLine: "#e0e7ea",
    equipLineOn: "#e0e7ea",
    series: ["#4d9be6", "#f0913a", "#a585e8", "#35b5a5", "#e86a9a", "#b3c23f"],
  },
  // For bright light or poor eyesight: black, white text and lines, full-strength colours.
  contrast: {
    dark: true,
    bg: "#000000",
    surface: "#000000",
    surface2: "#111111",
    line: "#ffffff",
    text: "#ffffff",
    text2: "#ffffff",
    text3: "#d9d9d9",
    track: "#4d4d4d",
    ctl: "#ffffff",
    tones: { accent: "#3ab0ff", ok: "#22e06a", warn: "#ffd400", alarm: "#ff4136", neutral: "#a6a6a6" },
    pipe: "#a6a6a6",
    // Deep enough for white text (the level number) and still clear on black.
    liquid: "#1f78d1",
    equip: "#000000",
    equipOn: "#000000",
    equipLine: "#ffffff",
    equipLineOn: "#ffffff",
    series: ["#3ab0ff", "#ffa31a", "#c9a0ff", "#22e0c8", "#ff7eb6", "#d8f03a"],
  },
};

/**
 * Sizes at 1280x720, in CSS pixels; other panel sizes scale them by `k` (scaleOf).
 * native.ts converts font sizes for CODESYS with PT.
 */
export const TYPE = {
  /** The screen's title in the top bar. */
  title: 18,
  /** Card titles, rail labels. */
  card: 13,
  body: 14,
  small: 12,
  tiny: 11,
  /** The big number of a value card. */
  value: 34,
  /** A smaller number (set-point, state). */
  valueS: 24,
  unit: 14,
} as const;

/** CODESYS's font size per CSS pixel (checked on SP21: its sizes render as pixels). */
export const PT = 1;

// Chinese, Japanese and Korean characters (and full-width forms) are about one em wide, where a
// Latin letter averages a little over half of one. Widths estimated from string length cut CJK
// titles off: the batch mixer's "批次配料搅拌装置" showed as "批次配料搅".
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/gu;

/** Whether a text has CJK characters. */
export const hasCjk = (t: string): boolean => (WIDE.lastIndex = 0, WIDE.test(t));

/** A text's length in average Latin letters: a CJK character counts as 1.8. */
export const textLen = (t: string): number => {
  const wide = t.match(WIDE)?.length ?? 0;
  return [...t].length + wide * 0.8;
};

/** A text's width in pixels at `px`: Latin letters `latin` em each, CJK characters one em at no less than `minCjk`. */
export const textWidth = (t: string, px: number, latin = 0.56, minCjk = CJK_MIN): number => {
  const wide = t.match(WIDE)?.length ?? 0;
  return ([...t].length - wide) * px * latin + wide * Math.max(px, minCjk);
};

/**
 * The HMI's own words (buttons, captions), in the screen's language: on DeepSeek's Chinese batch
 * mixer they stayed English (Start, Login, Actual), and it built its own Chinese buttons instead.
 */
export const UI_WORDS = {
  en: { start: "Start", stop: "Stop", reset: "Reset", open: "Open", close: "Close", actual: "Actual", set: "Set", setpoint: "Set-point", login: "Login", manual: "Manual", auto: "Auto", noAlarms: "No active alarms", history: "History", running: "Running", fault: "Fault", normal: "normal", pending: "pending", active: "active", cleared: "cleared", acknowledged: "acknowledged" },
  zh: { start: "启动", stop: "停止", reset: "复位", open: "打开", close: "关闭", actual: "实际", set: "设定", setpoint: "设定值", login: "登录", manual: "手动", auto: "自动", noAlarms: "无活动报警", history: "历史", running: "运行", fault: "故障", normal: "正常", pending: "待定", active: "激活", cleared: "已清除", acknowledged: "已确认" },
  ja: { start: "起動", stop: "停止", reset: "リセット", open: "開く", close: "閉じる", actual: "実測", set: "設定", setpoint: "設定値", login: "ログイン", manual: "手動", auto: "自動", noAlarms: "アクティブなアラームなし", history: "履歴", running: "運転", fault: "故障", normal: "正常", pending: "保留", active: "発生中", cleared: "解除", acknowledged: "確認済" },
  ko: { start: "시작", stop: "정지", reset: "리셋", open: "열기", close: "닫기", actual: "실제", set: "설정", setpoint: "설정값", login: "로그인", manual: "수동", auto: "자동", noAlarms: "활성 알람 없음", history: "이력", running: "운전", fault: "고장", normal: "정상", pending: "대기", active: "활성", cleared: "해제", acknowledged: "확인됨" },
} as const;
export type UiWords = { readonly [K in keyof (typeof UI_WORDS)["en"]]: string };

/** The language of a screen's own texts (title, subtitle, card titles, machine states): kana Japanese, Hangul Korean, other CJK Chinese, else English. */
export function uiWords(screen: { title: string; subtitle?: string; widgets?: { title?: string }[]; machine?: { states: { text: string }[]; idle: { text: string } } }): UiWords {
  const t = [screen.title, screen.subtitle ?? "", ...(screen.widgets ?? []).map((w) => w.title ?? ""), ...(screen.machine ? [screen.machine.idle.text, ...screen.machine.states.map((s) => s.text)] : [])].join(" ");
  if (/[ぁ-ヿ]/.test(t)) return UI_WORDS.ja;
  if (/[ᄀ-ᇿ가-힣]/.test(t)) return UI_WORDS.ko;
  return hasCjk(t) ? UI_WORDS.zh : UI_WORDS.en;
}

/** The font CJK text gets in CODESYS: Segoe UI has no CJK glyphs, and Windows' fallback at 11 px is hard to read. */
export const CJK_FONT = "Microsoft YaHei UI";
/** The smallest CJK text, in CSS pixels at 1280x720. */
export const CJK_MIN = 13;

export const SPACE = {
  /** The top bar's height. */
  bar: 56,
  /** The navigation rail's width (when the HMI has more than one page). */
  rail: 84,
  /** Margin around the cards. */
  pad: 16,
  /** Between cards. */
  gap: 12,
  /** Inside a card. */
  inset: 16,
  /** Corner radius of cards. */
  radius: 8,
  /** Corner radius of buttons and fields. */
  radiusS: 6,
  /** Minimum height of a touch control. */
  touch: 44,
  /** The bottom bar with Start/Stop and the mode (when the screen has a machine with commands). */
  dock: 64,
  /** The machine-state corner at the left of the top bar. */
  corner: 210,
  /** The line under the top bar in the machine state's colour. */
  stateLine: 3,
} as const;

/** Scale of a panel size against 1280x720. */
export function scaleOf(size: { w: number; h: number }): number {
  if (size.h <= 480) return 0.75;
  if (size.h >= 1080) return 1.5;
  return 1;
}

/** 0xRRGGBB of '#rrggbb'. */
export const rgbOf = (hex: string): number => parseInt(hex.slice(1), 16);

/** a over b by t (0..1), as '#rrggbb'. */
export function mixHex(a: string, b: string, t: number): string {
  const x = rgbOf(a), y = rgbOf(b);
  const ch = (s: number) => Math.round(((x >>> s) & 255) * t + ((y >>> s) & 255) * (1 - t));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** Black-ish or white text on a colour, whichever reads better. */
export function textOn(hex: string): string {
  return darkTextOn(rgbOf(hex)) ? "#111820" : "#ffffff";
}

/** A tone's pale background (alarm rows, the selected page), on the theme's surface. */
export function softOf(t: Theme, tone: string): string {
  return mixHex(tone, t.surface, t.dark ? 0.2 : 0.11);
}

/** The theme with the brand colour as its accent. */
export function themeFor(screen: { theme?: ThemeName; accent?: string }): Theme {
  const t = THEMES[screen.theme ?? "light"];
  return screen.accent ? { ...t, tones: { ...t.tones, accent: screen.accent.toLowerCase() } } : t;
}

/** The theme as CSS custom properties, for the browser screen. */
export function themeCss(t: Theme): string {
  const v: Record<string, string> = {
    bg: t.bg,
    surface: t.surface,
    surface2: t.surface2,
    line: t.line,
    fg: t.text,
    text2: t.text2,
    muted: t.text3,
    track: t.track,
    ctl: t.ctl,
    pipe: t.pipe,
    liquid: t.liquid,
    equip: t.equip,
    "equip-on": t.equipOn,
    "equip-line-on": t.equipLineOn,
    "equip-line": t.equipLine,
    ...Object.fromEntries(Object.entries(t.tones).flatMap(([k, c]) => [[k, c], [`${k}-soft`, softOf(t, c)], [`on-${k}`, textOn(c)]])),
  };
  return Object.entries(v).map(([k, c]) => `--${k}:${c}`).join(";");
}

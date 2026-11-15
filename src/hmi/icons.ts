/**
 * Line icons for the HMI: one style (24x24, 1.8 stroke, round ends), drawn in
 * the current colour. Used in card titles, the navigation rail, buttons and the
 * state panel, in the browser and (as pictures) in CODESYS. Pure.
 */

/** Path data per icon, in a 24x24 box. */
export const ICONS = {
  home: "M3.5 11 12 4l8.5 7M6 9.5V20h4.5v-5.5h3V20H18V9.5",
  process: "M3 5h6v5H3zM15 14h6v5h-6zM9 7.5h3.5v9H15",
  trend: "M3.5 20h17M4 16l5-6 4 3.5L20 6",
  alarm: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  settings: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1M17 6.5a2 2 0 1 1-4 0a2 2 0 1 1 4 0M11 12a2 2 0 1 1-4 0a2 2 0 1 1 4 0M19 17.5a2 2 0 1 1-4 0a2 2 0 1 1 4 0",
  recipe: "M6 3.5h12v17H6zM9 8h6M9 12h6M9 16h3.5",
  user: "M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  login: "M6.5 11h11v9.5h-11zM9 11V8a3 3 0 0 1 6 0v3",
  play: "M8 5.5v13l10.5-6.5z",
  stop: "M7 7h10v10H7z",
  pause: "M9 6v12M15 6v12",
  reset: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  info: "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.01",
  warning: "M12 4 2.8 19.5h18.4zM12 10v4.5M12 17v.01",
  fault: "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM12 7.5v6M12 16.5v.01",
  manual: "M8.5 12V6a1.5 1.5 0 0 1 3 0v5V4.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v7.5a6.5 6.5 0 0 1-6.5 6.5h-.5a6 6 0 0 1-4.6-2.2L4.6 14a1.5 1.5 0 0 1 2.3-1.9z",
  auto: "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM8.5 16l3.5-8.5 3.5 8.5M9.7 13.2h4.6",
  temperature: "M14 14.3V5a2 2 0 0 0-4 0v9.3a4 4 0 1 0 4 0zM12 16.5V9",
  pressure: "M12 21a8.5 8.5 0 1 0 0-17a8.5 8.5 0 0 0 0 17zM12 12.5l3.5-3.5M7.5 13h.01M12 7.5v.01M16.5 13h.01",
  flow: "M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0",
  level: "M5 4h14v16H5zM5 12.5c2.3-1.3 4.7-1.3 7 0s4.7 1.3 7 0",
  speed: "M3.5 17a8.5 8.5 0 0 1 17 0M12 17l4.5-5M3.5 17h3M17.5 17h3",
  power: "M13 3 5.5 13.5h5.5L10 21l8-10.5h-5.5z",
  time: "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM12 7v5l3.5 2",
  count: "M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16",
  heater: "M12 3.5c3 3.5 5.5 6 5.5 10a5.5 5.5 0 0 1-11 0c0-2.4 1.3-4 2.8-5.2c0 2 .9 3.2 2.2 3.2c0-3-.9-5 .5-8z",
  pump: "M11 19.5a6.5 6.5 0 1 0 0-13a6.5 6.5 0 0 0 0 13zM11 6.5h9v4M8.5 10l5 3-5 3z",
  valve: "M3 7v10l9-5zM21 7v10l-9-5zM12 12V5M9 5h6",
  tank: "M5 7v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7M5 7c0 1.4 3.1 2.5 7 2.5S19 8.4 19 7s-3.1-2.5-7-2.5S5 5.6 5 7z",
  energy: "M4 20h16M7 20v-5M12 20V9M17 20v-8",
  language: "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9",
  order: "M7 3.5h7.5L18 7v13.5H7zM14.5 3.5V7H18M9.5 11.5h6M9.5 15h6",
  machine: "M3 20h18M4.5 20V9l5 3V9l5 3V9l5 3v8M8 16h1.5M12.5 16H14",
} as const;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as [IconName, ...IconName[]];

/** Icons drawn filled as well as stroked (solid shapes read better small). */
const FILLED = new Set<IconName>(["play", "stop"]);

/** The icon as an inline SVG, `px` wide, in the current text colour. */
export function iconSvg(name: IconName, px: number, cls = "ic"): string {
  const fill = FILLED.has(name) ? "currentColor" : "none";
  return `<svg class="${cls}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

/** The icon as a standalone SVG picture in one colour (CODESYS image pool). */
export function iconPicture(name: IconName, px: number, color: string): string {
  const fill = FILLED.has(name) ? color : "none";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="${ICONS[name]}" fill="${fill}" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

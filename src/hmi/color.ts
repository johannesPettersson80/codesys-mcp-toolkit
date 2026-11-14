/** Colour helpers shared by the browser HMI and the native export. Pure. */

/** Whether dark text reads better than white on a colour (0xRRGGBB), by WCAG relative luminance. */
export function darkTextOn(rgb: number): boolean {
  const lin = (s: number) => {
    const v = ((rgb >>> s) & 0xff) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(16) + 0.7152 * lin(8) + 0.0722 * lin(0) > 0.179;
}

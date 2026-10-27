/**
 * The MyPixelTeam mark: an agent seen from behind, at a glowing monitor. One character per
 * pixel, "." for none. The app draws it as SVG; scripts/make-icon.ts turns it into the
 * window and installer icons.
 */
export const LOGO_ROWS = [
  "................",
  "..KKKKKKKKKKKK..",
  "..KSSSSSSSSSSK..",
  "..KSLLSSSSSSSK..",
  "..KSLSSSSSSSSK..",
  "..KSSSSSSSSSSK..",
  "..KSSSjjjjSSSK..",
  "..KSSjjHHHHSSK..",
  "..KSSHHHHHHSSK..",
  "..KKKHHHHHHKKK..",
  ".....HHHHHH.....",
  ".......kk.......",
  "...gGGGGGGGGg...",
  "..gGGGGGGGGGGg..",
  "..gGGGGGGGGGGg..",
  "................",
];

export const LOGO_COLORS: Record<string, string> = {
  K: "#2a1f2e",
  S: "#8fd3f4",
  L: "#d7f0fc",
  H: "#6b4228",
  j: "#8a5a36",
  k: "#e9b98f",
  G: "#5fae7a",
  g: "#47875c",
};

export interface LogoPixel {
  x: number;
  y: number;
  color: string;
}

export function logoPixels(): LogoPixel[] {
  const pixels: LogoPixel[] = [];
  LOGO_ROWS.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const color = LOGO_COLORS[c];
      if (color) pixels.push({ x, y, color });
    }),
  );
  return pixels;
}

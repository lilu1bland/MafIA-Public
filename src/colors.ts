export interface GameColor {
  name: string;
  rgb: [number, number, number];
}

export const COLORS: GameColor[] = [
  { name: "Crimson", rgb: [220, 38, 38] },
  { name: "Azure", rgb: [37, 99, 235] },
  { name: "Emerald", rgb: [16, 185, 129] },
  { name: "Amber", rgb: [245, 158, 11] },
  { name: "Violet", rgb: [139, 92, 246] },
  { name: "Rose", rgb: [244, 63, 94] },
  { name: "Teal", rgb: [20, 184, 166] },
  { name: "Lime", rgb: [132, 204, 22] },
  { name: "Cyan", rgb: [6, 182, 212] },
  { name: "Orange", rgb: [249, 115, 22] },
  { name: "Indigo", rgb: [99, 102, 241] },
  { name: "Fuchsia", rgb: [217, 70, 239] },
  { name: "Slate", rgb: [148, 163, 184] },
  { name: "Sand", rgb: [214, 189, 141] },
  { name: "Mint", rgb: [110, 231, 183] },
  { name: "Coral", rgb: [251, 113, 133] },
  { name: "Sky", rgb: [56, 189, 248] },
  { name: "Olive", rgb: [163, 163, 47] },
  { name: "Plum", rgb: [162, 84, 158] },
  { name: "Rust", rgb: [180, 83, 9] },
];

export function cssColor(c: GameColor): string {
  return `rgb(${c.rgb[0]}, ${c.rgb[1]}, ${c.rgb[2]})`;
}

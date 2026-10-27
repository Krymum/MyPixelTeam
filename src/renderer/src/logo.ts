import { LOGO_ROWS, logoPixels } from "../../shared/logo";

const SVG = "http://www.w3.org/2000/svg";

/** The pixel mark as SVG, one rect per pixel so it stays sharp at any size. */
export function logoSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${LOGO_ROWS.length} ${LOGO_ROWS.length}`);
  svg.setAttribute("aria-hidden", "true");
  for (const { x, y, color } of logoPixels()) {
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "1");
    rect.setAttribute("height", "1");
    rect.setAttribute("fill", color);
    svg.append(rect);
  }
  return svg;
}

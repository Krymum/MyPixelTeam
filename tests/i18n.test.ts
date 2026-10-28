import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fill } from "../src/shared/format";
import { FR } from "../src/renderer/src/i18n-fr";

/** Every text the interface writes, read from the code: t("…"), tr("…") and tn(n, "…", "…"). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const STRING = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
const CALLS = [
  new RegExp(String.raw`\b(?:t|tr)\(\s*${STRING}`, "g"),
  new RegExp(String.raw`\btn\(\s*[^,]+,\s*${STRING},\s*${STRING}`, "g"),
];
const unquote = (literal: string): string =>
  literal.startsWith("'")
    ? literal.slice(1, -1).replace(/\\'/g, "'")
    : (JSON.parse(literal) as string);

export function interfaceTexts(): Set<string> {
  const texts = new Set<string>();
  for (const file of sources("src/renderer/src")) {
    const code = readFileSync(file, "utf8");
    for (const pattern of CALLS)
      for (const m of code.matchAll(pattern))
        for (const literal of m.slice(1)) if (literal) texts.add(unquote(literal));
  }
  // Labels the interface translates from elsewhere: run states, needs, checks.
  const states = readFileSync("src/shared/work/run-state.ts", "utf8");
  for (const m of states.matchAll(/"([A-Z][^"]*)"/g)) texts.add(m[1]!);
  const board = readFileSync("src/renderer/src/work/board.ts", "utf8");
  const ci = /const CI_LABELS = \{([^}]*)\}/.exec(board)![1]!;
  for (const m of ci.matchAll(/"([^"]+)"/g)) texts.add(m[1]!);
  return texts;
}

describe("French", () => {
  const texts = interfaceTexts();

  it("translates every text of the interface", () => {
    const missing = [...texts].filter((text) => !(text in FR));
    expect(missing).toEqual([]);
  });

  it("keeps the placeholders of each text", () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const wrong = Object.entries(FR).filter(([en, fr]) => names(en).join() !== names(fr).join());
    expect(wrong).toEqual([]);
  });

  it("has no entry the interface no longer uses", () => {
    expect(Object.keys(FR).filter((en) => !texts.has(en))).toEqual([]);
  });

  it("fills placeholders", () => {
    expect(fill(FR["{key} opened a pull request"]!, { key: "#7" })).toBe(
      "#7 a ouvert une pull request",
    );
  });
});

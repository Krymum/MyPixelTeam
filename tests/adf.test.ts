import { describe, expect, it } from "vitest";
import { adfToText, textToAdf } from "../src/main/integrations/adf";

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string) => ({ type: "text", text: t });

describe("adfToText", () => {
  it("renders paragraphs, headings, lists and code", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Goal")] },
        para(
          text("Fix "),
          { type: "text", text: "login", marks: [{ type: "strong" }] },
          { type: "hardBreak" },
          { type: "mention", attrs: { text: "@Ana" } },
        ),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [para(text("one"))] },
            { type: "listItem", content: [para(text("two"))] },
          ],
        },
        { type: "codeBlock", content: [text("npm test")] },
      ],
    };
    expect(adfToText(doc)).toBe("## Goal\n\nFix login\n@Ana\n\n- one\n- two\n\n```\nnpm test\n```");
  });

  it("copes with empty or odd input", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText("plain")).toBe("plain");
    expect(adfToText({ type: "doc" })).toBe("");
  });
});

describe("textToAdf", () => {
  it("keeps paragraphs and line breaks", () => {
    expect(textToAdf("a\nb\r\n\r\nc")).toEqual({
      type: "doc",
      version: 1,
      content: [para(text("a"), { type: "hardBreak" }, text("b")), para(text("c"))],
    });
  });

  it("round-trips plain text", () => {
    const plain = "First line\nsecond line\n\nNext paragraph";
    expect(adfToText(textToAdf(plain))).toBe(plain);
  });

  it("gives an empty document for blank text", () => {
    expect(textToAdf("  \n\n ").content).toEqual([]);
  });
});

describe("embedded files", () => {
  it("names them instead of a bare [attachment]", () => {
    const media = (alt?: string) => ({ type: "media", attrs: { id: "m1", type: "file", alt } });
    const doc = {
      type: "doc",
      version: 1,
      content: [
        para(text("See")),
        { type: "mediaSingle", content: [media("screen.png")] },
        { type: "mediaGroup", content: [media("log.txt"), media()] },
        para(text("inline "), { type: "mediaInline", attrs: { alt: "spec.pdf" } }),
      ],
    };
    expect(adfToText(doc).split("\n")).toEqual([
      "See",
      "",
      "[attachment: screen.png]",
      "",
      "[attachment: log.txt]",
      "[attachment]",
      "",
      "inline [attachment: spec.pdf]",
    ]);
  });
});

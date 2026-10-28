import { parseMarkdown, type Inline } from "../../shared/markdown";
import { button, el, link } from "./dom";

/** Ticket text and agent summaries, readable: Markdown turned into DOM nodes. */

function inline(nodes: Inline[]): Node[] {
  return nodes.map((n) => {
    switch (n.t) {
      case "text":
        return document.createTextNode(n.v);
      case "code":
        return el("code", n.v);
      case "b":
      case "i": {
        const node = el(n.t === "b" ? "strong" : "em");
        node.append(...inline(n.c));
        return node;
      }
      case "link": {
        const a = link("", n.href);
        a.append(...inline(n.c));
        return a;
      }
    }
  });
}

export function markdown(text: string): HTMLElement {
  const root = el("div", undefined, "md");
  for (const b of parseMarkdown(text)) {
    switch (b.type) {
      case "p": {
        const p = el("p");
        p.append(...inline(b.c));
        root.append(p);
        break;
      }
      case "h": {
        // Ticket headings sit inside a panel: they stay small.
        const h = el(b.level <= 2 ? "h5" : "h6");
        h.append(...inline(b.c));
        root.append(h);
        break;
      }
      case "list": {
        const list = el(b.ordered ? "ol" : "ul");
        for (const item of b.items) {
          const li = el("li");
          li.append(...inline(item));
          list.append(li);
        }
        root.append(list);
        break;
      }
      case "code":
        root.append(el("pre", b.text, "log"));
        break;
      case "quote": {
        const q = el("blockquote");
        q.append(...inline(b.c));
        root.append(q);
        break;
      }
    }
  }
  return root;
}

/** Long text folded to a few lines, with "Read more" to unfold it. */
export function foldedMarkdown(text: string, lines = 8): HTMLElement {
  const box = el("div", undefined, "folded");
  const body = markdown(text);
  box.append(body);
  if (text.split("\n").length <= lines && text.length < 600) return box;
  box.classList.add("closed");
  box.style.setProperty("--fold-lines", String(lines));
  const toggle = button(
    "Read more",
    () => {
      const closed = box.classList.toggle("closed");
      toggle.textContent = closed ? "Read more" : "Show less";
    },
    "link",
  );
  box.append(toggle);
  return box;
}

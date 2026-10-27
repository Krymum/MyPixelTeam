/**
 * The bit of Markdown tickets, comments and agent summaries use, read into a small tree
 * the renderer turns into DOM nodes: no HTML string is ever built, so nothing in a ticket
 * can inject markup.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b" | "i"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { type: "p"; c: Inline[] }
  | { type: "h"; level: number; c: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "code"; text: string }
  | { type: "quote"; c: Inline[] };

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", c: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "h", level: heading[1]!.length, c: parseInline(heading[2]!) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = Boolean(item[1]);
      const items: Inline[][] = [];
      let current = item[2]!;
      while (++i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]!);
        if (next) {
          items.push(parseInline(current));
          current = next[2]!;
        } else if (/^\s{2,}\S/.test(lines[i]!)) current += ` ${lines[i]!.trim()}`;
        else break;
      }
      items.push(parseInline(current));
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      blocks.push({ type: "quote", c: parseInline(line.replace(/^>\s?/, "")) });
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)\*(?!\w)|(?<!\w)_(?!\s)(.+?)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push({ t: "text", v: text.slice(at, m.index) });
    const [, code, bold, bold2, it, it2, label, href, bare] = m;
    if (code !== undefined) out.push({ t: "code", v: code });
    else if (bold !== undefined || bold2 !== undefined)
      out.push({ t: "b", c: parseInline((bold ?? bold2)!) });
    else if (it !== undefined || it2 !== undefined)
      out.push({ t: "i", c: parseInline((it ?? it2)!) });
    else if (label !== undefined) out.push({ t: "link", href: href!, c: parseInline(label) });
    else out.push({ t: "link", href: bare!, c: [{ t: "text", v: bare! }] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ t: "text", v: text.slice(at) });
  return out;
}

/**
 * Atlassian Document Format <-> plain text. Jira Cloud stores descriptions and comments as
 * ADF; the office shows and edits them as text, which is also what an agent's prompt needs.
 * Text -> ADF keeps paragraphs and line breaks only, so saving drops rich formatting.
 */

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

function inline(nodes: AdfNode[] = []): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.text ?? "";
        case "hardBreak":
          return "\n";
        case "mention":
        case "emoji":
          return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
        case "inlineCard":
          return String(n.attrs?.url ?? "");
        case "mediaInline":
          return typeof n.attrs?.alt === "string" ? `[attachment: ${n.attrs.alt}]` : "[attachment]";
        default:
          return inline(n.content);
      }
    })
    .join("");
}

function block(node: AdfNode, indent = ""): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return indent + inline(children);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inline(children)}`;
    case "codeBlock":
      return `\`\`\`\n${inline(children)}\n\`\`\``;
    case "bulletList":
    case "orderedList":
      return children
        .map((item, i) => {
          const marker = node.type === "bulletList" ? "- " : `${i + 1}. `;
          const [first = "", ...rest] = (item.content ?? []).map((c) =>
            block(c, `${indent}  `).trimStart(),
          );
          return [`${indent}${marker}${first}`, ...rest.map((r) => `${indent}  ${r}`)].join("\n");
        })
        .join("\n");
    case "blockquote":
      return children.map((c) => `> ${block(c)}`).join("\n");
    case "rule":
      return "---";
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
    case "media": {
      // A file embedded from the ticket's attachments; Jira keeps its name in `alt`.
      const media = node.type === "media" || node.type === "mediaInline" ? [node] : children;
      return media
        .map((m) => {
          const name = m.attrs?.alt;
          return typeof name === "string" && name ? `[attachment: ${name}]` : "[attachment]";
        })
        .join("\n");
    }
    case "table":
      return children
        .map((row) =>
          (row.content ?? [])
            .map((cell) => (cell.content ?? []).map((c) => block(c)).join(" "))
            .join(" | "),
        )
        .join("\n");
    default:
      return children.length ? children.map((c) => block(c, indent)).join("\n\n") : inline([node]);
  }
}

export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  const node = doc as AdfNode | null | undefined;
  if (!node || !Array.isArray(node.content)) return "";
  return node.content
    .map((n) => block(n))
    .join("\n\n")
    .trim();
}

export function textToAdf(text: string): AdfDoc {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: p.split("\n").flatMap((line, i): AdfNode[] => {
        const text: AdfNode[] = line ? [{ type: "text", text: line }] : [];
        return i === 0 ? text : [{ type: "hardBreak" }, ...text];
      }),
    })),
  };
}

/** Tiny DOM helpers: the renderer has no framework. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(text: string, onClick: () => void, className?: string): HTMLButtonElement {
  const b = el("button", text, className);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** Link opened in the system browser (the window refuses to navigate). */
export function link(text: string, href: string): HTMLAnchorElement {
  const a = el("a", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const l = el("label", undefined, "field");
  l.append(el("span", label));
  l.append(control);
  if (hint) l.append(el("small", hint));
  return l;
}

export function input(value = "", placeholder = "", type = "text"): HTMLInputElement {
  const i = el("input");
  i.type = type;
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

export function select(
  options: [value: string, label: string][],
  value?: string,
): HTMLSelectElement {
  const s = el("select");
  for (const [v, label] of options) {
    const o = el("option", label);
    o.value = v;
    s.append(o);
  }
  if (value !== undefined) s.value = value;
  return s;
}

export function textarea(value = "", rows = 6): HTMLTextAreaElement {
  const t = el("textarea");
  t.value = value;
  t.rows = rows;
  return t;
}

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Runs an action with its button disabled, and shows its error (or clears it) in `status`.
 * Returns the action's result, or undefined when it failed.
 */
export async function busy<T>(
  control: HTMLButtonElement | undefined,
  status: HTMLElement,
  action: () => Promise<T>,
): Promise<T | undefined> {
  if (control) control.disabled = true;
  status.textContent = "";
  status.className = "status";
  try {
    return await action();
  } catch (err) {
    status.textContent = errorText(err);
    status.className = "status bad";
    return undefined;
  } finally {
    if (control) control.disabled = false;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

import { fill } from "../../shared/format";
import { FR } from "./i18n-fr";

/**
 * The interface's words, in English or French. Each text is written in English at its call
 * site, values apart ("{key} is done"), and looked up in the French dictionary when the app
 * speaks French; a missing entry falls back to English. Tickets, comments and agent
 * output are shown as written.
 */

export type Language = "en" | "fr";
export type LanguageChoice = "auto" | Language;

const KEY = "mypixelteam.language";

export function languageChoice(): LanguageChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "en" || saved === "fr" ? saved : "auto";
  } catch {
    return "auto";
  }
}

/** The system's language when nothing was picked. */
export const language: Language = (() => {
  const choice = languageChoice();
  if (choice !== "auto") return choice;
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
})();

/** Every text is built once per render: the page reloads to switch. */
export function setLanguage(choice: LanguageChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Not saved: the system's language stays.
  }
  location.reload();
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const template = language === "fr" ? (FR[text] ?? text) : text;
  return vars ? fill(template, vars) : template;
}

/** `one` when n is 1 (or 0 in French), `many` otherwise; both get `{n}`. */
export function tn(
  n: number,
  one: string,
  many: string,
  vars: Record<string, string | number> = {},
): string {
  const single = language === "fr" ? n <= 1 : n === 1;
  return t(single ? one : many, { n, ...vars });
}

/** Times and dates in the interface's language. */
export const locale = (): string => (language === "fr" ? "fr-FR" : "en-US");

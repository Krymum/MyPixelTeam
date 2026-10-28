import { update } from "./store";

/**
 * Runs the person already dealt with (a pull request reviewed, a failure looked at): they
 * leave "Needs you". Kept in this browser only; losing it just brings them back.
 */

const KEY = "mypixelteam.dismissed";
const LIMIT = 200;

function load(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const ids = new Set(load());

export const dismissed = (): ReadonlySet<string> => ids;

export function dismiss(runId: string): void {
  ids.add(runId);
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids].slice(-LIMIT)));
  } catch {
    // Not saved: it only comes back after a restart.
  }
  // Everyone showing what needs the person redraws.
  update({});
}

import type { JiraProject } from "./types";

/**
 * Jira projects a repository's name points at, best first: "acme/billing-api" and the
 * project "BILL · Billing" share "billing"; "web/crm-front" matches the key "CRM". Used when
 * there is no git history to read keys from (a repository not cloned yet).
 */

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);

export function jiraKeysForRepo(fullName: string, projects: JiraProject[]): string[] {
  const slug = fullName.split("/").pop() ?? fullName;
  const repoWords = new Set(words(slug));
  const joined = words(slug).join("");
  const scored = projects
    .map((p) => {
      const key = p.key.toLowerCase();
      const name = words(p.name);
      let score = 0;
      if (repoWords.has(key)) score += 3;
      if (name.length && name.join("") === joined) score += 4;
      score += name.filter((w) => w.length >= 3 && repoWords.has(w)).length * 2;
      return { key: p.key, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((p) => p.key);
}

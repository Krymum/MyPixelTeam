import type { GitProviderId, JiraProject, Tracker } from "../../../shared/work/types";
import { t } from "../i18n";

/** The "Tickets from" choice: GitHub Issues (GitHub repositories only) or a Jira project. */

export function trackerOptions(
  provider: GitProviderId | undefined,
  jiraProjects: JiraProject[],
  /** Jira keys to list first, e.g. those seen in the repository. */
  preferred: string[] = [],
): [string, string][] {
  const first = new Set(preferred);
  const jira = [
    ...jiraProjects.filter((p) => first.has(p.key)),
    ...jiraProjects.filter((p) => !first.has(p.key)),
  ];
  return [
    ...(provider === "github"
      ? [["github", t("GitHub Issues of the repository")] as [string, string]]
      : []),
    ...jira.map((p): [string, string] => [`jira:${p.key}`, `Jira · ${p.key} · ${p.name}`]),
  ];
}

export const trackerValue = (tracker: Tracker): string =>
  tracker.kind === "jira" ? `jira:${tracker.projectKey}` : "github";

export function parseTracker(value: string): Tracker | undefined {
  if (value === "github") return { kind: "github" };
  if (value.startsWith("jira:")) return { kind: "jira", projectKey: value.slice(5) };
  return undefined;
}

import type { OfficeEvent } from "../../shared/protocol/schema";
import type { RunView } from "../../shared/work/types";

/** What the desktop notifications say. */

export interface Notice {
  title: string;
  body: string;
}

const clip = (text: string, max = 180): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function runNotice(run: RunView): Notice | undefined {
  const ticket = `${run.issueKey}${run.issueSummary ? ` · ${run.issueSummary}` : ""}`;
  switch (run.status) {
    case "done":
      return {
        title: run.pullRequestUrl ? `${run.issueKey}: pull request ready` : `${run.issueKey}: done`,
        body: clip(run.pullRequestUrl ? ticket : `${ticket}\n${run.result ?? "No changes"}`),
      };
    case "failed":
      return { title: `${run.issueKey}: the agent failed`, body: clip(run.error ?? ticket) };
    default:
      return undefined;
  }
}

export function waitingNotice(event: OfficeEvent): Notice | undefined {
  if (event.type !== "agent.waiting") return undefined;
  return {
    title: `${event.agentName ?? "An agent"} is waiting for you`,
    body: clip(event.detail.message ?? event.cwd ?? "It needs an answer to go on."),
  };
}

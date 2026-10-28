import type { OfficeEvent } from "../../shared/protocol/schema";
import type { RunView } from "../../shared/work/types";

/** What the desktop notifications say, in English or French (the system's language). */

export interface Notice {
  title: string;
  body: string;
}

export type NoticeLanguage = "en" | "fr";

const WORDS = {
  en: {
    pullRequest: (key: string) => `${key}: pull request ready`,
    done: (key: string) => `${key}: done`,
    noChanges: "No changes",
    failed: (key: string) => `${key}: the agent failed`,
    waiting: (name: string) => `${name} is waiting for you`,
    anAgent: "An agent",
    needsAnswer: "It needs an answer to go on.",
  },
  fr: {
    pullRequest: (key: string) => `${key} : pull request prête`,
    done: (key: string) => `${key} : terminé`,
    noChanges: "Aucun changement",
    failed: (key: string) => `${key} : l’agent a échoué`,
    waiting: (name: string) => `${name} t’attend`,
    anAgent: "Un agent",
    needsAnswer: "Il a besoin d’une réponse pour continuer.",
  },
};

const clip = (text: string, max = 180): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function runNotice(run: RunView, language: NoticeLanguage = "en"): Notice | undefined {
  const w = WORDS[language];
  const ticket = `${run.issueKey}${run.issueSummary ? ` · ${run.issueSummary}` : ""}`;
  switch (run.status) {
    case "done":
      return {
        title: run.pullRequestUrl ? w.pullRequest(run.issueKey) : w.done(run.issueKey),
        body: clip(run.pullRequestUrl ? ticket : `${ticket}\n${run.result ?? w.noChanges}`),
      };
    case "failed":
      return { title: w.failed(run.issueKey), body: clip(run.error ?? ticket) };
    default:
      return undefined;
  }
}

export function waitingNotice(
  event: OfficeEvent,
  language: NoticeLanguage = "en",
): Notice | undefined {
  if (event.type !== "agent.waiting") return undefined;
  const w = WORDS[language];
  return {
    title: w.waiting(event.agentName ?? w.anAgent),
    body: clip(event.detail.message ?? event.cwd ?? w.needsAnswer),
  };
}

import { z } from "zod";

/**
 * Types shared by the main process (which talks to Jira, GitHub and Bitbucket and runs the
 * agents) and the renderer (which only ever sees these views, never a token).
 */

export const GIT_PROVIDERS = ["github", "bitbucket"] as const;
export type GitProviderId = (typeof GIT_PROVIDERS)[number];
export type ProviderId = "jira" | GitProviderId;

export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Connection details typed in the settings dialog. Tokens travel only renderer -> main. */
export type AccountInput =
  | { provider: "jira"; site: string; email: string; token: string }
  | { provider: "github"; token: string }
  | { provider: "bitbucket"; email: string; token: string };

/** What the renderer may know about a connected account. */
export interface AccountView {
  provider: ProviderId;
  /** Display name of the connected user. */
  user: string;
  /** Jira site or email, for the settings dialog. */
  detail?: string;
}

export interface AccountsView {
  accounts: AccountView[];
  /** False when the OS offers no secure storage: accounts can't be saved. */
  secureStorage: boolean;
}

export interface JiraProject {
  key: string;
  name: string;
}

export interface RepoRef {
  provider: GitProviderId;
  /** owner/name (GitHub) or workspace/slug (Bitbucket). */
  fullName: string;
  defaultBranch: string;
  cloneUrl: string;
  webUrl: string;
}

export interface RepoSummary extends RepoRef {
  private: boolean;
}

/** Where a project's tickets live: a Jira project, or the GitHub Issues of its repository. */
export const Tracker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("jira"), projectKey: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("github") }),
]);
export type Tracker = z.infer<typeof Tracker>;

export const trackerLabel = (tracker: Tracker): string =>
  tracker.kind === "jira" ? `Jira ${tracker.projectKey}` : "GitHub Issues";

/** "PROJ-12" (Jira) or "#12" (GitHub). */
export const isIssueKey = (key: string): boolean => /^([A-Z][A-Z0-9_]+-\d+|#\d+)$/.test(key);

/** Issue key safe in branch and folder names: "#12" -> "issue-12". */
export const issueSlug = (key: string): string => key.replace(/^#/, "issue-");

/** Claude model aliases offered for agents, cheapest last. */
export const AGENT_MODELS = [
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["haiku", "Haiku"],
] as const;
/** Most tickets don't need Opus, which costs several times more. */
export const DEFAULT_MODEL = "sonnet";
export const MODEL_PATTERN = /^[\w.:[\]-]*$/;

/** The model an agent on this project uses unless the ticket's run picks another. */
export const projectModel = (project: Pick<Project, "agent">): string =>
  project.agent.model?.trim() || DEFAULT_MODEL;

const ProjectFields = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    tracker: Tracker,
    repo: z.object({
      provider: z.enum(GIT_PROVIDERS),
      fullName: z.string().min(1),
      defaultBranch: z.string().min(1),
      cloneUrl: z.url(),
      webUrl: z.url(),
    }),
    /** Local clone. Created on the first run when missing. */
    localPath: z.string().min(1),
    /** Branch new work starts from and pull requests target; the repository's default otherwise. */
    baseBranch: z
      .string()
      .max(200)
      .regex(/^(?!.*[.][.])[A-Za-z0-9._/-]*$/, "Base branch: letters, digits and . _ / - only")
      .optional(),
    agent: z.object({
      permissionMode: z.enum(PERMISSION_MODES).default("acceptEdits"),
      /** Claude model alias or name; DEFAULT_MODEL when empty. */
      model: z
        .string()
        .max(100)
        .regex(MODEL_PATTERN, "Model: letters, digits and . - _ : [ ] only")
        .optional(),
      /** Appended to every ticket prompt, e.g. "run npm test before finishing". */
      instructions: z.string().max(4000).optional(),
      /** Push the branch, open a pull request and move the ticket to review. */
      openPullRequest: z.boolean().default(true),
    }),
  })
  .refine((p) => p.tracker.kind !== "github" || p.repo.provider === "github", {
    message: "GitHub Issues need a GitHub repository",
    path: ["tracker"],
  });

/** Projects saved before trackers existed always used Jira. */
export const Project = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || "tracker" in raw || !("jiraProjectKey" in raw)) return raw;
  const { jiraProjectKey, ...rest } = raw as Record<string, unknown>;
  return { ...rest, tracker: { kind: "jira", projectKey: jiraProjectKey } };
}, ProjectFields);
export type Project = z.infer<typeof Project>;
/** Sent by the settings dialog; the id is assigned on creation. */
export type ProjectInput = Omit<Project, "id"> & { id?: string };

export const MAX_AGENTS = 8;

export const Workspace = z.object({
  projects: z.array(Project).default([]),
  activeProjectId: z.string().optional(),
  /** The setup guide was finished or skipped; it no longer opens on launch. */
  onboarded: z.boolean().default(false),
  /** Desktop notifications when an agent finishes, fails or waits for you. */
  notifications: z.boolean().default(true),
  /** Agents working at the same time; the next tickets wait their turn. */
  maxAgents: z.number().int().min(1).max(MAX_AGENTS).default(2),
});
export type Workspace = z.infer<typeof Workspace>;

/** One thing the machine needs before agents can work. */
export interface CheckResult {
  ok: boolean;
  /** Version, account or other detail when ok; what is wrong otherwise. */
  detail: string;
}

export interface EnvironmentCheck {
  git: CheckResult;
  claude: CheckResult;
  /** Claude Code is signed in (or has an API key). */
  claudeAuth: CheckResult;
}

/** A repository found on this machine that could become a project. */
export interface DiscoveredProject {
  /** Root of the local checkout. */
  path: string;
  /** Last time Claude Code worked there (epoch ms); 0 for a folder picked by hand. */
  lastUsed: number;
  /** Parsed from the origin remote, when it is GitHub or Bitbucket. */
  remote?: { provider: GitProviderId; fullName: string };
  /** The repository as the connected account sees it; missing when not accessible. */
  repo?: RepoRef;
  /** Jira project keys seen in branch names and commit messages, most frequent first. */
  jiraKeys: string[];
  /** Why it can't be added as is. */
  problem?: string;
}

export type StatusCategory = "new" | "indeterminate" | "done";

export interface IssueSummary {
  key: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory;
  type: string;
  priority?: string;
  assignee?: string;
  updated: string;
  url: string;
}

export interface Transition {
  id: string;
  name: string;
  to: string;
}

export interface IssueComment {
  author: string;
  created: string;
  text: string;
  /** Written by someone trusted with the repository; others never reach an agent. */
  trusted: boolean;
}

/** A file attached to a ticket. Its content is fetched by the main process, with the account. */
export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  author?: string;
  created?: string;
  /** Opens it in the tracker's web page (the browser has its own sign-in). */
  url?: string;
}

/** Images shown inline; anything else is only offered for saving. */
export const isPreviewable = (a: Pick<Attachment, "mimeType">): boolean =>
  /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.mimeType);

/** Actions the Jira account is allowed to take in the issue's project. */
export interface IssuePermissions {
  edit: boolean;
  transition: boolean;
  comment: boolean;
  create: boolean;
}

export interface IssueDetail extends IssueSummary {
  /** Plain-text rendering of the description. */
  description: string;
  author?: string;
  /**
   * The author can be trusted with the agent's instructions. Always true for Jira (a
   * company's own tracker); on GitHub only owners, members and collaborators are, since
   * anyone can open an issue on a public repository.
   */
  trusted: boolean;
  /** Anyone can open issues there. */
  publicRepo?: boolean;
  transitions: Transition[];
  comments: IssueComment[];
  attachments: Attachment[];
  permissions: IssuePermissions;
  /** The epic (Jira) or parent issue (GitHub) holding this ticket. */
  parent?: IssueSummary;
  /** The tickets this one holds, when it is an epic or a parent issue. */
  children?: IssueSummary[];
}

export interface IssueType {
  id: string;
  name: string;
}

export interface IssueQuery {
  text?: string;
  includeDone?: boolean;
}

export interface NewIssue {
  issueTypeId: string;
  summary: string;
  description?: string;
  /** The epic (Jira) or parent issue (GitHub) the new ticket belongs to. */
  parentKey?: string;
}

export interface IssueChanges {
  summary?: string;
  description?: string;
}

export type RunStatus =
  "queued" | "preparing" | "running" | "publishing" | "done" | "failed" | "cancelled";

export interface StartRunOptions {
  /** Run on an issue from an untrusted author, after the person read it. */
  allowUntrusted?: boolean;
  /** Work on this existing branch from origin instead of a new one from the base. */
  branch?: string;
  /** Claude model for this run; the project's otherwise. */
  model?: string;
}

/** Where an agent can work on a ticket. */
export interface TicketBranches {
  /** Branch a new one starts from. */
  base: string;
  /** Name of the branch the app would create. */
  newBranch: string;
  /** Branches on origin whose name contains the ticket key, the ticket's own first. */
  existing: string[];
}

/** How to sign in to GitHub besides pasting a token. */
export interface GitHubLoginOptions {
  /** "Sign in with GitHub" in the browser (needs an OAuth app client id). */
  deviceFlow: boolean;
  /** GitHub CLI is installed and signed in: its token can be reused. */
  githubCli: boolean;
}

/** Code to type on github.com/login/device. */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface HooksStatus {
  /** ~/.claude/settings.json */
  settingsPath: string;
  installed: boolean;
  /** Installed, but pointing at another copy of the app. */
  outdated: boolean;
  /** Hooks run `node`; missing Node.js makes them useless. */
  node: CheckResult;
}

/** An agent asks before using a tool its permission mode doesn't allow on its own. */
export interface AgentQuestion {
  id: string;
  /** Tool name, e.g. "Bash" or "PowerShell". */
  tool: string;
  /** A few words: "npm test", "edit src/app.ts". */
  summary: string;
  /** What exactly would run: the command, the file, or the tool's input. */
  detail: string;
  /** Why, in the agent's words, when it said. */
  reason?: string;
  /** What "always allow for this run" would allow, e.g. "npm test:*", when offered. */
  alwaysRule?: string;
  askedAt: number;
}

/** An answer to an agent's question. "always" also allows the same again for this run. */
export type QuestionAnswer = "allow" | "always" | "deny";

export interface ContinueOptions {
  /** Pass the pull request's review comments on to the agent. */
  includeReview?: boolean;
}

export interface RunView {
  id: string;
  projectId: string;
  issueKey: string;
  issueSummary: string;
  /** Claude Code session id; the office character carries it. */
  sessionId: string;
  status: RunStatus;
  branch: string;
  worktree: string;
  startedAt: number;
  endedAt?: number;
  pullRequestUrl?: string;
  /** Last message from the agent, used as the pull request description. */
  result?: string;
  error?: string;
  costUsd?: number;
  /** Recent progress lines, newest last. */
  log: string[];
  /** Questions waiting for an answer; the agent is paused on them. */
  questions?: AgentQuestion[];
  /** The agent's session started: a later run can resume it. */
  agentStarted?: boolean;
  /** This run resumed the session of that run, with `instruction`. */
  continuedFrom?: string;
  instruction?: string;
  /** Claude model the agent runs on. */
  model?: string;
  /** Stopped by the Claude usage limit: the agent picks the ticket up again at this time. */
  resumeAt?: number;
}

export const isActiveRun = (run: RunView): boolean =>
  run.status === "queued" ||
  run.status === "preparing" ||
  run.status === "running" ||
  run.status === "publishing";

/** The branch new work starts from. */
export const baseBranchOf = (project: Pick<Project, "baseBranch" | "repo">): string =>
  project.baseBranch?.trim() || project.repo.defaultBranch;

import type { OfficeEvent } from "../shared/protocol/schema";
import type {
  AccountInput,
  AccountsView,
  DeviceCode,
  DiscoveredProject,
  EnvironmentCheck,
  GitHubLoginOptions,
  GitProviderId,
  HooksStatus,
  IssueChanges,
  IssueDetail,
  IssueQuery,
  IssueSummary,
  IssueType,
  JiraProject,
  NewIssue,
  ProjectInput,
  ProviderId,
  RepoSummary,
  RunView,
  StartRunOptions,
  TicketBranches,
  Workspace,
} from "../shared/work/types";

export const IPC = {
  event: "office:event",
  history: "office:history",
  info: "office:info",
  runs: "work:runs",
  /** A notification was clicked: show this ticket. */
  openIssue: "work:open-issue",
} as const;

/** Request/response calls of the work API, by channel. Each takes the listed arguments. */
export const WORK_CALLS = [
  "checkEnvironment",
  "githubLoginOptions",
  "githubCliLogin",
  "githubDeviceStart",
  "githubDeviceWait",
  "githubDeviceCancel",
  "hooksStatus",
  "installHooks",
  "uninstallHooks",
  "discoverProjects",
  "inspectFolder",
  "setPreferences",
  "accounts",
  "connect",
  "disconnect",
  "jiraProjects",
  "repos",
  "defaultPath",
  "pickFolder",
  "workspace",
  "saveProject",
  "deleteProject",
  "setActiveProject",
  "issues",
  "issue",
  "issueTypes",
  "createIssue",
  "updateIssue",
  "transition",
  "comment",
  "attachmentPreview",
  "saveAttachment",
  "runs",
  "ticketBranches",
  "startRun",
  "cancelRun",
  "answerQuestion",
] as const;

export interface ServerInfo {
  url: string;
  listening: boolean;
  error?: string;
  demo: boolean;
  /** Folder of Claude Code transcripts being followed, when that is on. */
  transcripts?: string;
  configPath?: string;
  /** Why office.config.json was ignored, if it was. */
  configError?: string;
  /** Dev aid (AGENT_OFFICE_OPEN): a panel to open at start, for screenshots. */
  openOnStart?: "board" | "settings";
}

/**
 * Jira, code hosts and agent runs. Everything runs in the main process: tokens never reach
 * the renderer. Failed calls reject with the service's error message.
 */
export interface WorkApi {
  /** git, Claude Code and its sign-in on this machine. */
  checkEnvironment(): Promise<EnvironmentCheck>;
  githubLoginOptions(): Promise<GitHubLoginOptions>;
  /** Connects GitHub with the GitHub CLI's login. */
  githubCliLogin(): Promise<AccountsView>;
  /** Opens github.com/login/device in the browser and returns the code to type there. */
  githubDeviceStart(): Promise<DeviceCode>;
  /** Waits until the code is approved, then connects GitHub. */
  githubDeviceWait(): Promise<AccountsView>;
  githubDeviceCancel(): Promise<void>;
  /** Claude Code hooks in ~/.claude/settings.json. */
  hooksStatus(): Promise<HooksStatus>;
  installHooks(): Promise<HooksStatus>;
  uninstallHooks(): Promise<HooksStatus>;
  /** Repositories Claude Code worked in lately that aren't projects yet. */
  discoverProjects(): Promise<DiscoveredProject[]>;
  /** The same analysis for a folder picked by hand; undefined when it is already a project. */
  inspectFolder(path: string): Promise<DiscoveredProject | undefined>;
  setPreferences(
    prefs: Partial<Pick<Workspace, "onboarded" | "notifications">>,
  ): Promise<Workspace>;
  accounts(): Promise<AccountsView>;
  /** Checks the credentials, then stores them encrypted. */
  connect(input: AccountInput): Promise<AccountsView>;
  disconnect(provider: ProviderId): Promise<AccountsView>;
  jiraProjects(): Promise<JiraProject[]>;
  repos(provider: GitProviderId): Promise<RepoSummary[]>;
  /** Where a repository is cloned when no folder is chosen. */
  defaultPath(provider: GitProviderId, fullName: string): Promise<string>;
  pickFolder(): Promise<string | undefined>;
  workspace(): Promise<Workspace>;
  saveProject(project: ProjectInput): Promise<Workspace>;
  deleteProject(id: string): Promise<Workspace>;
  setActiveProject(id: string | undefined): Promise<Workspace>;
  issues(projectId: string, query?: IssueQuery): Promise<IssueSummary[]>;
  issue(projectId: string, key: string): Promise<IssueDetail>;
  issueTypes(projectId: string): Promise<IssueType[]>;
  /** Returns the new issue key. */
  createIssue(projectId: string, issue: NewIssue): Promise<string>;
  updateIssue(projectId: string, key: string, changes: IssueChanges): Promise<void>;
  transition(projectId: string, key: string, transitionId: string): Promise<void>;
  comment(projectId: string, key: string, text: string): Promise<void>;
  /** An image attachment as a data: URL, for an <img>. */
  attachmentPreview(projectId: string, attachmentId: string): Promise<string>;
  /** Asks where to save an attachment, then writes it there; undefined when cancelled. */
  saveAttachment(
    projectId: string,
    attachmentId: string,
    filename: string,
  ): Promise<string | undefined>;
  runs(): Promise<RunView[]>;
  /** The base branch, the branch the app would create, and the ticket's branches on origin. */
  ticketBranches(projectId: string, issueKey: string, summary: string): Promise<TicketBranches>;
  /** Puts an agent on the ticket. */
  startRun(projectId: string, issueKey: string, options?: StartRunOptions): Promise<RunView>;
  cancelRun(id: string): Promise<void>;
  /** Allows or refuses what an agent asked; a refusal's message reaches the agent. */
  answerQuestion(
    runId: string,
    questionId: string,
    allow: boolean,
    message?: string,
  ): Promise<void>;
  onRuns(listener: (runs: RunView[]) => void): () => void;
  onOpenIssue(listener: (projectId: string, issueKey: string) => void): () => void;
}

/** Surface exposed to the renderer as `window.office`. */
export interface OfficeApi {
  /** Subscribes to live events; returns an unsubscribe function. */
  onEvent(listener: (event: OfficeEvent) => void): () => void;
  /** Recent events, so a reloaded renderer can rebuild the office. */
  history(): Promise<OfficeEvent[]>;
  info(): Promise<ServerInfo>;
  work: WorkApi;
}

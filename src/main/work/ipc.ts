import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { WORK_CALLS, type WorkApi } from "../../preload/api";
import {
  baseBranchOf,
  isActiveRun,
  isPreviewable,
  type GitProviderId,
  type RepoSummary,
} from "../../shared/work/types";
import { branchesForIssue, branchName, ensureClone, remoteBranches } from "./git";
import type { AccountStore } from "./accounts";
import { discoverProjects, recentFolders, unreachable, type DiscoverOptions } from "./discover";
import { DeviceLogin, githubCliToken, githubClientId } from "../integrations/github-login";
import { checkEnvironment, exec } from "./environment";
import { hooksStatus, installHooks, uninstallHooks } from "./hooks";
import { guideTicket, hasAgentGuide } from "./project-guide";
import type { AgentRunner } from "./runner";
import type { WorkspaceStore } from "./workspace";

type Handlers = Omit<WorkApi, "onRuns" | "onOpenIssue">;

/** Main-process side of `window.office.work`. */
export function registerWorkIpc(deps: {
  accounts: AccountStore;
  workspace: WorkspaceStore;
  runner: AgentRunner;
  window: () => BrowserWindow | null;
  claude: string;
  transcriptRoot: string;
  /** Folders whose sessions are the app's own agents. */
  ownFolders: string[];
  /** Claude Code settings file and the hook script it should run. */
  hooks: { settingsPath: string; adapterPath: string };
}): void {
  const { accounts, workspace, runner } = deps;
  const tracker = (projectId: string) => accounts.tracker(workspace.get(projectId));

  /** What discovery compares folders against, fetched once per search. */
  async function discoveryContext(): Promise<Omit<DiscoverOptions, "folders">> {
    const connected = new Set(accounts.view().accounts.map((a) => a.provider));
    const cache = new Map<GitProviderId, Promise<RepoSummary[] | undefined>>();
    const repos = (provider: GitProviderId) => {
      if (!connected.has(provider)) return Promise.resolve(undefined);
      if (!cache.has(provider)) cache.set(provider, accounts.git(provider).repos());
      return cache.get(provider)!;
    };
    const jiraKeys = connected.has("jira")
      ? (await accounts.jira().projects()).map((p) => p.key)
      : undefined;
    const existing = new Set(
      workspace.view().projects.map((p) => `${p.repo.provider}:${p.repo.fullName.toLowerCase()}`),
    );
    const lookup = async (provider: GitProviderId, fullName: string) => {
      const user = accounts.view().accounts.find((a) => a.provider === provider)?.user;
      try {
        return await accounts.git(provider).repo(fullName);
      } catch (err) {
        return unreachable(provider, fullName, user, err);
      }
    };
    return { exclude: deps.ownFolders, existing, repos, lookup, jiraKeys };
  }

  /** The GitHub sign-in in progress, if any. */
  let device: DeviceLogin | undefined;
  const hookState = () => hooksStatus(deps.hooks.settingsPath, deps.hooks.adapterPath, exec);

  const handlers: Handlers = {
    githubLoginOptions: async () => ({
      deviceFlow: Boolean(githubClientId()),
      githubCli: Boolean(await githubCliToken(exec)),
    }),
    githubCliLogin: async () => {
      const token = await githubCliToken(exec);
      if (!token) throw new Error("GitHub CLI is not signed in: run `gh auth login` first");
      return accounts.connect({ provider: "github", token });
    },
    githubDeviceStart: async () => {
      device?.cancel();
      device = new DeviceLogin(githubClientId());
      const code = await device.start();
      void shell.openExternal(code.verificationUri);
      return code;
    },
    githubDeviceWait: async () => {
      if (!device) throw new Error("Start the sign-in first");
      const token = await device.token();
      device = undefined;
      return accounts.connect({ provider: "github", token });
    },
    githubDeviceCancel: async () => {
      device?.cancel();
      device = undefined;
    },
    hooksStatus: hookState,
    installHooks: async () => {
      installHooks(deps.hooks.settingsPath, deps.hooks.adapterPath);
      return hookState();
    },
    uninstallHooks: async () => {
      uninstallHooks(deps.hooks.settingsPath);
      return hookState();
    },
    checkEnvironment: () => checkEnvironment(deps.claude),
    discoverProjects: async () =>
      discoverProjects({
        ...(await discoveryContext()),
        folders: recentFolders(deps.transcriptRoot),
      }),
    inspectFolder: async (path) => {
      const context = await discoveryContext();
      const [found] = await discoverProjects({
        ...context,
        exclude: [],
        folders: [{ path, lastUsed: 0 }],
      });
      return found;
    },
    setPreferences: async (prefs) => {
      const view = workspace.setPreferences(prefs);
      // More agents allowed: queued tickets can start now.
      runner.drain();
      return view;
    },
    accounts: async () => accounts.view(),
    connect: (input) => accounts.connect(input),
    disconnect: async (provider) => accounts.disconnect(provider),
    jiraProjects: () => accounts.jira().projects(),
    repos: (provider) => accounts.git(provider).repos(),
    defaultPath: async (provider, fullName) => workspace.defaultPath(provider, fullName),
    pickFolder: async () => {
      const win = deps.window();
      const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return res.canceled ? undefined : res.filePaths[0];
    },
    workspace: async () => workspace.view(),
    saveProject: async (project) => workspace.save(project),
    deleteProject: async (id) => workspace.remove(id),
    setActiveProject: async (id) => workspace.setActive(id),
    issues: (projectId, query) => tracker(projectId).search(query),
    issue: (projectId, key) => tracker(projectId).issue(key),
    issueTypes: (projectId) => tracker(projectId).issueTypes(),
    createIssue: (projectId, issue) => tracker(projectId).create(issue),
    updateIssue: (projectId, key, changes) => tracker(projectId).update(key, changes),
    transition: (projectId, key, id) => tracker(projectId).transition(key, id),
    comment: (projectId, key, text) => tracker(projectId).comment(key, text),
    attachmentPreview: async (projectId, id) => {
      const { mimeType, data } = await tracker(projectId).attachment(id);
      // Only images become data: URLs; the page shows them with <img>, which runs no script.
      if (!isPreviewable({ mimeType })) throw new Error(`No preview for ${mimeType} files`);
      return `data:${mimeType};base64,${data.toString("base64")}`;
    },
    saveAttachment: async (projectId, id, filename) => {
      const win = deps.window();
      // Never opened by the app: an attachment can be anything, including a program.
      const options = { defaultPath: join(app.getPath("downloads"), basename(filename)) };
      const res = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return undefined;
      const { data } = await tracker(projectId).attachment(id);
      await writeFile(res.filePath, data);
      return res.filePath;
    },
    runs: async () => runner.list(),
    ticketBranches: async (projectId, key, summary) => {
      const project = workspace.get(projectId);
      const auth = accounts.git(project.repo.provider).gitAuth();
      // The first look at a project clones it; later ones only ask origin for its branches.
      await ensureClone(project.repo.cloneUrl, project.localPath, auth);
      const newBranch = branchName(key, summary);
      const found = branchesForIssue(await remoteBranches(project.localPath, auth), key);
      return {
        base: baseBranchOf(project),
        newBranch,
        existing: [
          ...found.filter((b) => b === newBranch),
          ...found.filter((b) => b !== newBranch),
        ],
      };
    },
    startRun: async (projectId, key, options) => runner.start(projectId, key, options),
    cancelRun: async (id) => runner.cancel(id),
    startEpic: (projectId, epicKey) => runner.startEpic(projectId, epicKey),
    agentGuide: (projectId) => hasAgentGuide(workspace.get(projectId)),
    prepareProject: async (projectId) => {
      const key = await guideTicket(tracker(projectId));
      // Already on it: the ticket shows that agent.
      if (!runner.list().some((r) => r.issueKey === key && isActiveRun(r)))
        runner.start(projectId, key);
      return key;
    },
    answerQuestion: async (runId, questionId, answer, message) =>
      runner.answer(runId, questionId, answer, message),
    continueRun: async (runId, instruction, options) =>
      runner.continueRun(runId, instruction, options),
  };

  for (const name of WORK_CALLS) {
    const handler = handlers[name] as (...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(`work:${name}`, (_, ...args: unknown[]) => handler(...args));
  }
}

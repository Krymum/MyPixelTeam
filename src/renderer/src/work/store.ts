import type {
  AccountsView,
  EnvironmentCheck,
  Project,
  RunView,
  Workspace,
} from "../../../shared/work/types";

/** Work state shared by the top bar, the board and the settings dialog. */
export interface WorkState {
  accounts: AccountsView;
  workspace: Workspace;
  runs: RunView[];
  /** Last machine check; undefined while it runs. */
  environment?: EnvironmentCheck;
}

type Listener = (state: WorkState) => void;

const listeners = new Set<Listener>();

export const work: WorkState = {
  accounts: { accounts: [], secureStorage: true },
  workspace: {
    projects: [],
    onboarded: false,
    notifications: true,
    maxAgents: 2,
    runBudgetUsd: 3,
    fixCi: true,
    commentCommands: true,
  },
  runs: [],
};

export function update(patch: Partial<WorkState>): void {
  Object.assign(work, patch);
  for (const l of listeners) l(work);
}

export function subscribe(listener: Listener): void {
  listeners.add(listener);
}

export function activeProject(): Project | undefined {
  const { projects, activeProjectId } = work.workspace;
  return projects.find((p) => p.id === activeProjectId) ?? projects[0];
}

export const connected = (provider: string): boolean =>
  work.accounts.accounts.some((a) => a.provider === provider);

export async function loadWork(): Promise<void> {
  const api = window.office.work;
  const [accounts, workspace, runs] = await Promise.all([
    api.accounts(),
    api.workspace(),
    api.runs(),
  ]);
  update({ accounts, workspace, runs });
  api.onRuns((runs) => update({ runs }));
}

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Project, Workspace, type ProjectInput } from "../../shared/work/types";

/** Projects the agents can work on: a Jira project paired with a repository. */
export class WorkspaceStore {
  private state: Workspace = { projects: [], onboarded: false, notifications: true };

  constructor(
    private readonly path: string,
    /** Where repositories are cloned when no local folder is given. */
    private readonly reposDir: string,
  ) {
    if (!existsSync(path)) return;
    try {
      const parsed = Workspace.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) this.state = parsed.data;
      else console.error(`[mypixelteam] ${path} ignored: ${z.prettifyError(parsed.error)}`);
    } catch (err) {
      console.error(`[mypixelteam] could not read ${path}:`, err);
    }
  }

  view(): Workspace {
    return structuredClone(this.state);
  }

  get(id: string): Project {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) throw new Error("Unknown project");
    return project;
  }

  /** Default clone location for a repository. */
  defaultPath(provider: string, fullName: string): string {
    return join(this.reposDir, provider, ...fullName.split("/"));
  }

  save(input: ProjectInput): Workspace {
    const id = input.id ?? randomUUID();
    const localPath =
      input.localPath?.trim() || this.defaultPath(input.repo.provider, input.repo.fullName);
    const parsed = Project.safeParse({ ...input, id, localPath });
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    const projects = this.state.projects.filter((p) => p.id !== id);
    const index = this.state.projects.findIndex((p) => p.id === id);
    projects.splice(index < 0 ? projects.length : index, 0, parsed.data);
    this.state = { ...this.state, projects, activeProjectId: this.state.activeProjectId ?? id };
    this.write();
    return this.view();
  }

  remove(id: string): Workspace {
    const projects = this.state.projects.filter((p) => p.id !== id);
    const active = this.state.activeProjectId === id ? projects[0]?.id : this.state.activeProjectId;
    this.state = { ...this.state, projects, activeProjectId: active };
    this.write();
    return this.view();
  }

  setActive(id: string | undefined): Workspace {
    if (id !== undefined) this.get(id);
    this.state = { ...this.state, activeProjectId: id };
    this.write();
    return this.view();
  }

  /** Preferences stored next to the projects. */
  setPreferences(prefs: Partial<Pick<Workspace, "onboarded" | "notifications">>): Workspace {
    this.state = { ...this.state, ...prefs };
    this.write();
    return this.view();
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildContinuePrompt, buildPrompt } from "../src/main/work/agent-protocol";
import { git } from "../src/main/work/git";
import { GUIDE_TICKET, guideTicket, hasAgentGuide } from "../src/main/work/project-guide";
import type { IssueDetail, Project } from "../src/shared/work/types";

const project = (localPath: string) =>
  ({
    tracker: { kind: "github" },
    repo: { fullName: "acme/app", defaultBranch: "main" },
    localPath,
    agent: {},
  }) as Project;

describe("agent guide", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-guide-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("looks for CLAUDE.md or AGENTS.md on the base branch of origin", async () => {
    const seed = join(dir, "seed");
    const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
    await git(["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    await git(["add", "."], { cwd: seed });
    await git([...identity, "commit", "-q", "-m", "init"], { cwd: seed });
    const clone = join(dir, "clone");
    await git(["clone", "-q", seed, clone]);
    expect(await hasAgentGuide(project(clone))).toBe(false);

    writeFileSync(join(seed, "CLAUDE.md"), "# Map\n");
    await git(["add", "."], { cwd: seed });
    await git([...identity, "commit", "-q", "-m", "guide"], { cwd: seed });
    await git(["fetch", "-q"], { cwd: clone });
    expect(await hasAgentGuide(project(clone))).toBe(true);
    // Not cloned yet.
    expect(await hasAgentGuide(project(join(dir, "missing")))).toBe(false);
  });

  it("reuses the open guide ticket instead of opening another", async () => {
    const created: unknown[] = [];
    const tracker = (open: { key: string; summary: string }[]) =>
      ({
        search: async () => open,
        issueTypes: async () => [
          { id: "1", name: "Epic" },
          { id: "2", name: "Task" },
        ],
        create: async (issue: unknown) => (created.push(issue), "PROJ-9"),
      }) as never;
    expect(await guideTicket(tracker([{ key: "PROJ-3", summary: GUIDE_TICKET.summary }]))).toBe(
      "PROJ-3",
    );
    expect(await guideTicket(tracker([{ key: "PROJ-4", summary: "Other" }]))).toBe("PROJ-9");
    expect(created).toEqual([{ issueTypeId: "2", ...GUIDE_TICKET }]);
  });
});

describe("cost-saving instructions", () => {
  it("ask every run for targeted reading and checks", () => {
    const issue = {
      key: "#1",
      type: "bug",
      summary: "Fix",
      description: "",
      comments: [],
    } as unknown as IssueDetail;
    const p = project("/repo");
    for (const prompt of [
      buildPrompt(issue, p, { branch: "b", base: "main", existing: false }),
      buildContinuePrompt(issue, p, "b", "Go on"),
    ]) {
      expect(prompt).toMatch(/Read only what the ticket needs/);
      expect(prompt).toMatch(/Leave the full test suite, end-to-end runs/);
      expect(prompt).toMatch(/Take screenshots only when/);
    }
  });
});

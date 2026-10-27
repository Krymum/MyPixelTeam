import { describe, expect, it } from "vitest";
import { BitbucketProvider, GitHubProvider } from "../src/main/integrations/git-providers";
import { fakeFetch } from "./work-helpers";

const pr = { title: "PROJ-1: Fix", body: "Done", head: "agent/PROJ-1-fix", base: "main" };

describe("GitHubProvider", () => {
  it("lists repositories", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user/repos": [
        {
          full_name: "acme/app",
          default_branch: "main",
          clone_url: "https://github.com/acme/app.git",
          html_url: "https://github.com/acme/app",
          private: true,
          owner: { login: "acme" },
        },
      ],
    });
    expect(await new GitHubProvider("ghp", fetch).repos()).toEqual([
      {
        provider: "github",
        fullName: "acme/app",
        defaultBranch: "main",
        cloneUrl: "https://github.com/acme/app.git",
        webUrl: "https://github.com/acme/app",
        private: true,
      },
    ]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer ghp");
  });

  it("opens a pull request, or finds the open one", async () => {
    const created = fakeFetch({
      "POST /repos/acme/app/pulls": { html_url: "https://github.com/acme/app/pull/1" },
    });
    expect(await new GitHubProvider("t", created.fetch).pullRequest("acme/app", pr)).toBe(
      "https://github.com/acme/app/pull/1",
    );
    expect(created.calls[0]!.body).toEqual({
      title: pr.title,
      body: pr.body,
      head: pr.head,
      base: "main",
    });

    const existing = fakeFetch({
      "POST /repos/acme/app/pulls": [422, { message: "A pull request already exists" }],
      "GET /repos/acme/app/pulls": [{ html_url: "https://github.com/acme/app/pull/2" }],
    });
    expect(await new GitHubProvider("t", existing.fetch).pullRequest("acme/app", pr)).toBe(
      "https://github.com/acme/app/pull/2",
    );
    expect(existing.calls[1]!.url).toContain(`head=${encodeURIComponent("acme:agent/PROJ-1-fix")}`);
  });

  it("rethrows when no pull request could be opened", async () => {
    const failing = fakeFetch({
      "POST /repos/acme/app/pulls": [422, { message: "No commits between main and branch" }],
      "GET /repos/acme/app/pulls": [],
    });
    await expect(
      new GitHubProvider("t", failing.fetch).pullRequest("acme/app", pr),
    ).rejects.toThrow("No commits");
  });

  it("asks for one repository directly", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/app": {
        full_name: "acme/app",
        default_branch: "dev",
        clone_url: "https://github.com/acme/app.git",
        html_url: "https://github.com/acme/app",
        private: true,
        owner: { login: "acme" },
      },
    });
    const gh = new GitHubProvider("t", fetch);
    expect((await gh.repo("acme/app")).defaultBranch).toBe("dev");
    await expect(gh.repo("acme/nope")).rejects.toMatchObject({ status: 404 });
  });

  it("uses the token for git", () => {
    expect(new GitHubProvider(" t ").gitAuth()).toEqual({
      username: "x-access-token",
      password: "t",
    });
  });
});

describe("BitbucketProvider", () => {
  const bbRepo = (fullName: string, extra: Record<string, unknown> = {}) => ({
    full_name: fullName,
    is_private: true,
    links: { html: { href: `https://bitbucket.org/${fullName}` } },
    ...extra,
  });

  it("lists every workspace's repositories, following pagination", async () => {
    const { fetch, calls } = fakeFetch({
      // Both shapes Bitbucket has used for workspace lists.
      "GET /2.0/user/workspaces": {
        values: [
          { workspace: { slug: "acme" } },
          { slug: "perso" },
          { workspace: { slug: "acme" } },
        ],
      },
      // Most specific first: routes match by prefix.
      "GET /2.0/repositories/acme?page=2": { values: [bbRepo("acme/lib")] },
      "GET /2.0/repositories/acme?": {
        values: [
          bbRepo("acme/app", {
            mainbranch: { name: "develop" },
            links: {
              html: { href: "https://bitbucket.org/acme/app" },
              clone: [{ name: "https", href: "https://me@bitbucket.org/acme/app.git" }],
            },
          }),
        ],
        next: "https://api.bitbucket.org/2.0/repositories/acme?page=2",
      },
      "GET /2.0/repositories/perso?": { values: [bbRepo("perso/notes")] },
    });
    const repos = await new BitbucketProvider("me@x.com", "tok", "me", fetch).repos();
    expect(repos.map((r) => [r.fullName, r.defaultBranch, r.cloneUrl])).toEqual([
      ["acme/app", "develop", "https://bitbucket.org/acme/app.git"],
      ["acme/lib", "main", "https://bitbucket.org/acme/lib.git"],
      ["perso/notes", "main", "https://bitbucket.org/perso/notes.git"],
    ]);
    // The removed cross-workspace listing is never called.
    expect(calls.some((c) => c.url.includes("/2.0/repositories?"))).toBe(false);
  });

  it("falls back to older workspace endpoints, but reports real errors", async () => {
    const older = fakeFetch({
      "GET /2.0/user/permissions/workspaces": { values: [{ workspace: { slug: "acme" } }] },
    });
    expect(await new BitbucketProvider("e", "t", "me", older.fetch).workspaces()).toEqual(["acme"]);

    const scopes = fakeFetch({
      "GET /2.0/user/workspaces": [403, { error: { message: "Your credentials lack scopes" } }],
    });
    await expect(new BitbucketProvider("e", "t", "me", scopes.fetch).repos()).rejects.toThrow(
      /lack scopes/,
    );
  });

  it("learns the username for git from the account", async () => {
    const { fetch } = fakeFetch({ "GET /2.0/user": { username: "me", display_name: "Me" } });
    const bb = new BitbucketProvider("me@x.com", "tok", undefined, fetch);
    expect(() => bb.gitAuth()).toThrow(/reconnect/);
    expect(await bb.whoami()).toBe("me");
    expect(bb.gitAuth()).toEqual({ username: "me", password: "tok" });
  });

  it("opens a pull request, or finds the open one", async () => {
    const created = fakeFetch({
      "POST /2.0/repositories/ws/app/pullrequests": {
        links: { html: { href: "https://bitbucket.org/ws/app/pull-requests/3" } },
      },
    });
    expect(
      await new BitbucketProvider("e", "t", "me", created.fetch).pullRequest("ws/app", pr),
    ).toBe("https://bitbucket.org/ws/app/pull-requests/3");
    expect(created.calls[0]!.body).toMatchObject({
      source: { branch: { name: pr.head } },
      destination: { branch: { name: "main" } },
    });

    const existing = fakeFetch({
      "POST /2.0/repositories/ws/app/pullrequests": [400, { error: { message: "exists" } }],
      "GET /2.0/repositories/ws/app/pullrequests": {
        values: [{ links: { html: { href: "https://bb/pr/4" } } }],
      },
    });
    expect(
      await new BitbucketProvider("e", "t", "me", existing.fetch).pullRequest("ws/app", pr),
    ).toBe("https://bb/pr/4");
  });
});

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccountInput,
  AccountView,
  AccountsView,
  Project,
  ProviderId,
} from "../../shared/work/types";
import { BitbucketProvider, GitHubProvider, type GitProvider } from "../integrations/git-providers";
import type { Fetch } from "../integrations/http";
import { JiraClient, normalizeSite } from "../integrations/jira";
import { GitHubIssues, JiraTracker, type IssueTracker } from "../integrations/trackers";

/**
 * Connected accounts. Tokens are encrypted with the OS keystore (Electron safeStorage:
 * DPAPI on Windows, Keychain on macOS, libsecret on Linux) and never leave the main process.
 */

export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

interface StoredAccounts {
  jira?: { site: string; email: string; token: string; user: string };
  github?: { token: string; user: string };
  bitbucket?: { email: string; token: string; user: string };
}

export class AccountStore {
  private accounts: StoredAccounts = {};

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
    private readonly fetchImpl?: Fetch,
  ) {
    if (!existsSync(path) || !cipher.available()) return;
    try {
      this.accounts = JSON.parse(cipher.decrypt(readFileSync(path)));
    } catch (err) {
      console.error(`[mypixelteam] could not read ${path}:`, err);
    }
  }

  view(): AccountsView {
    const a = this.accounts;
    const accounts: AccountView[] = [];
    if (a.jira) accounts.push({ provider: "jira", user: a.jira.user, detail: a.jira.site });
    if (a.github) accounts.push({ provider: "github", user: a.github.user });
    if (a.bitbucket)
      accounts.push({ provider: "bitbucket", user: a.bitbucket.user, detail: a.bitbucket.email });
    return { accounts, secureStorage: this.cipher.available() };
  }

  /** Checks the credentials against the service, then saves them. */
  async connect(input: AccountInput): Promise<AccountsView> {
    if (!this.cipher.available())
      throw new Error("No secure storage on this system: accounts can't be saved");
    switch (input.provider) {
      case "jira": {
        const creds = {
          site: normalizeSite(input.site),
          email: input.email.trim(),
          token: input.token.trim(),
        };
        const user = await new JiraClient(creds, this.fetchImpl).myself();
        this.accounts.jira = { ...creds, user };
        break;
      }
      case "github": {
        const token = input.token.trim();
        const user = await new GitHubProvider(token, this.fetchImpl).whoami();
        this.accounts.github = { token, user };
        break;
      }
      case "bitbucket": {
        const email = input.email.trim();
        const token = input.token.trim();
        const user = await new BitbucketProvider(email, token, undefined, this.fetchImpl).whoami();
        this.accounts.bitbucket = { email, token, user };
        break;
      }
    }
    this.save();
    return this.view();
  }

  disconnect(provider: ProviderId): AccountsView {
    delete this.accounts[provider];
    this.save();
    return this.view();
  }

  jira(): JiraClient {
    const a = this.accounts.jira;
    if (!a) throw new Error("Connect a Jira account in Settings first");
    return new JiraClient(a, this.fetchImpl);
  }

  /** Where the project's tickets live. */
  tracker(project: Project): IssueTracker {
    if (project.tracker.kind === "jira")
      return new JiraTracker(this.jira(), project.tracker.projectKey);
    const a = this.accounts.github;
    if (!a) throw new Error("Connect a GitHub account in Settings first");
    return new GitHubIssues(project.repo.fullName, a.token, this.fetchImpl);
  }

  git(provider: GitProvider["id"]): GitProvider {
    if (provider === "github") {
      const a = this.accounts.github;
      if (!a) throw new Error("Connect a GitHub account in Settings first");
      return new GitHubProvider(a.token, this.fetchImpl);
    }
    const a = this.accounts.bitbucket;
    if (!a) throw new Error("Connect a Bitbucket account in Settings first");
    return new BitbucketProvider(a.email, a.token, a.user, this.fetchImpl);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.cipher.encrypt(JSON.stringify(this.accounts)));
    renameSync(tmp, this.path);
  }
}

import type { DeviceCode } from "../../shared/work/types";
import type { Exec } from "../work/environment";
import { jsonClient, type Fetch } from "./http";

/**
 * Signing in to GitHub without creating a token by hand: reuse the GitHub CLI's login, or
 * the OAuth device flow ("enter this code on github.com"), which needs no client secret.
 *
 * The device flow needs the client id of a GitHub OAuth app with "Device Flow" enabled
 * (github.com/settings/developers -> New OAuth app). Client ids are public: whoever
 * publishes this app puts theirs here, or sets AGENT_OFFICE_GITHUB_CLIENT_ID.
 */
const DEFAULT_GITHUB_CLIENT_ID = "";

export const githubClientId = (): string =>
  process.env.AGENT_OFFICE_GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_CLIENT_ID;

/** Repositories (code, pull requests, issues), public and private. */
const SCOPE = "repo";

/** The GitHub CLI's token, when `gh` is installed and signed in. */
export async function githubCliToken(run: Exec): Promise<string | undefined> {
  const out = await run("gh", ["auth", "token"]);
  const token = out.stdout.trim();
  return out.code === 0 && token ? token : undefined;
}

interface CodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One sign-in attempt: show the code, then wait for the person to approve it on github.com. */
export class DeviceLogin {
  private readonly call;
  private cancelled = false;
  private pending?: { deviceCode: string; intervalMs: number; expiresAt: number };

  constructor(
    private readonly clientId: string,
    fetchImpl?: Fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    if (!clientId) throw new Error("GitHub sign-in is not set up in this build");
    this.call = jsonClient("https://github.com", {}, fetchImpl);
  }

  async start(): Promise<DeviceCode> {
    const res = await this.call<CodeResponse & TokenResponse>("POST", "/login/device/code", {
      client_id: this.clientId,
      scope: SCOPE,
    });
    if (res.error) throw new Error(res.error_description ?? res.error);
    const expiresAt = Date.now() + res.expires_in * 1000;
    this.pending = {
      deviceCode: res.device_code,
      intervalMs: (res.interval ?? 5) * 1000,
      expiresAt,
    };
    return { userCode: res.user_code, verificationUri: res.verification_uri, expiresAt };
  }

  /** Resolves with the token once approved; rejects when denied, expired or cancelled. */
  async token(): Promise<string> {
    const pending = this.pending;
    if (!pending) throw new Error("Start the sign-in first");
    for (;;) {
      await this.wait(pending.intervalMs);
      if (this.cancelled) throw new Error("Sign-in cancelled");
      if (Date.now() > pending.expiresAt) throw new Error("The code expired: try again");
      const res = await this.call<TokenResponse>("POST", "/login/oauth/access_token", {
        client_id: this.clientId,
        device_code: pending.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (res.access_token) return res.access_token;
      switch (res.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          pending.intervalMs = (res.interval ?? pending.intervalMs / 1000 + 5) * 1000;
          continue;
        case "access_denied":
          throw new Error("Sign-in refused on GitHub");
        case "expired_token":
          throw new Error("The code expired: try again");
        default:
          throw new Error(res.error_description ?? res.error ?? "GitHub sign-in failed");
      }
    }
  }

  cancel(): void {
    this.cancelled = true;
  }
}

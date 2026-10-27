import { execFile } from "node:child_process";
import type { CheckResult, EnvironmentCheck } from "../../shared/work/types";

/** Checks that this machine can run agents: git, the Claude Code CLI, and a signed-in Claude. */

interface Output {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all. */
  missing?: boolean;
}

export type Exec = (command: string, args: string[]) => Promise<Output>;

export const exec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      // npm installs Claude Code as a .cmd shim on Windows, which only a shell can start.
      { timeout: 20_000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        resolve({
          code: err ? (typeof code === "number" ? code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          missing: code === "ENOENT",
        });
      },
    );
  });

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/** Reads `claude auth status`, which prints JSON. */
export function readAuthStatus(out: Output, env: NodeJS.ProcessEnv = process.env): CheckResult {
  let status: AuthStatus | undefined;
  try {
    status = JSON.parse(out.stdout);
  } catch {
    status = undefined;
  }
  if (status?.loggedIn) {
    const who = [status.email, status.subscriptionType && `${status.subscriptionType} plan`]
      .filter(Boolean)
      .join(", ");
    return { ok: true, detail: who || status.authMethod || "signed in" };
  }
  if (env.ANTHROPIC_API_KEY) return { ok: true, detail: "API key (ANTHROPIC_API_KEY)" };
  if (status) return { ok: false, detail: "Not signed in" };
  return { ok: false, detail: firstLine(out.stderr) || "Could not read the sign-in status" };
}

export async function checkEnvironment(
  claude: string,
  run: Exec = exec,
): Promise<EnvironmentCheck> {
  const [git, version] = await Promise.all([run("git", ["--version"]), run(claude, ["--version"])]);
  const gitCheck: CheckResult =
    git.code === 0
      ? { ok: true, detail: firstLine(git.stdout) }
      : { ok: false, detail: git.missing ? "git is not installed" : firstLine(git.stderr) };
  if (version.code !== 0) {
    const detail = version.missing
      ? `Claude Code is not installed ("${claude}" not found)`
      : firstLine(version.stderr) || `"${claude} --version" failed`;
    return {
      git: gitCheck,
      claude: { ok: false, detail },
      claudeAuth: { ok: false, detail: "Install Claude Code first" },
    };
  }
  const auth = await run(claude, ["auth", "status"]);
  return {
    git: gitCheck,
    claude: { ok: true, detail: firstLine(version.stdout) },
    claudeAuth: readAuthStatus(auth),
  };
}

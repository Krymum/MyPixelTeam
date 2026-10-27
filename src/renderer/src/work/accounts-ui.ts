import type { AccountInput, GitHubLoginOptions, ProviderId } from "../../../shared/work/types";
import { busy, button, el, field, input, link } from "../dom";
import { update, work } from "./store";

/** Account forms, shared by the settings dialog and the setup guide. */

const api = () => window.office.work;

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  jira: "Jira Cloud",
  github: "GitHub",
  bitbucket: "Bitbucket Cloud",
};

/** What each account is for, so nobody connects what they don't use. */
export const PROVIDER_PURPOSE: Record<ProviderId, string> = {
  github: "Your code on GitHub. Its issues can be your tickets: nothing else needed.",
  bitbucket: "Only if your code is on Bitbucket. Its tickets then come from Jira.",
  jira: "Only if your tickets live in Jira.",
};

const ATLASSIAN_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** Connect or disconnect one account; `onChange` redraws whatever holds the card. */
export function accountCard(provider: ProviderId, onChange: () => void): HTMLElement {
  const card = el("div", undefined, "card");
  card.append(el("h4", PROVIDER_NAMES[provider]), el("p", PROVIDER_PURPOSE[provider], "muted"));
  const status = el("p", "", "status");
  const account = work.accounts.accounts.find((a) => a.provider === provider);

  if (account) {
    const who = el(
      "p",
      `Connected as ${account.user}${account.detail ? ` · ${account.detail}` : ""}`,
      "ok",
    );
    const disconnect = button(
      "Disconnect",
      () =>
        void busy(disconnect, status, async () => {
          update({ accounts: await api().disconnect(provider) });
          onChange();
        }),
    );
    card.append(who, disconnect, status);
    return card;
  }

  // The form stays folded until asked for: most people need one or two of the three.
  const form = el("div", undefined, "account-form");
  form.hidden = true;
  const open = button(`Connect ${PROVIDER_NAMES[provider]}…`, () => {
    open.hidden = true;
    form.hidden = false;
    form.querySelector("input")?.focus();
  });
  card.append(open, form);
  if (provider === "github") card.insertBefore(githubQuickLogin(onChange, open), open);

  const fields: Record<string, HTMLInputElement> = {};
  const add = (name: string, label: string, placeholder: string, type = "text", hint?: string) => {
    fields[name] = input("", placeholder, type);
    form.append(field(label, fields[name], hint));
  };
  if (provider === "jira") {
    add("site", "Site", "your-company.atlassian.net");
    add("email", "Email", "you@company.com", "email");
    add("token", "API token", "", "password");
    form.append(link("Create an API token", ATLASSIAN_TOKENS));
  } else if (provider === "github") {
    add(
      "token",
      "Personal access token",
      "github_pat_…",
      "password",
      "Fine-grained, on the repositories agents may use: Contents, Pull requests and Issues read & write.",
    );
    form.append(link("Create a token", "https://github.com/settings/personal-access-tokens/new"));
  } else {
    add("email", "Atlassian email", "you@company.com", "email");
    add(
      "token",
      "API token with scopes",
      "",
      "password",
      "Bitbucket scopes: read:user, read:workspace, read:repository, write:repository, read:pullrequest, write:pullrequest.",
    );
    form.append(link("Create an API token", ATLASSIAN_TOKENS));
  }

  const value = (name: string) => fields[name]?.value ?? "";
  const connect = button(
    "Connect",
    () =>
      void busy(connect, status, async () => {
        const input: AccountInput =
          provider === "jira"
            ? { provider, site: value("site"), email: value("email"), token: value("token") }
            : provider === "github"
              ? { provider, token: value("token") }
              : { provider, email: value("email"), token: value("token") };
        update({ accounts: await api().connect(input) });
        onChange();
      }),
    "primary",
  );
  const cancel = button("Cancel", () => {
    form.hidden = true;
    open.hidden = false;
  });
  const actions = el("div", undefined, "actions");
  actions.append(connect, cancel);
  form.append(actions, status);
  return card;
}

/** Asked once per launch: it starts `gh`, which is slow-ish. */
let loginOptions: Promise<GitHubLoginOptions> | undefined;

/**
 * Ways to connect GitHub without making a token: sign in in the browser, or reuse the
 * GitHub CLI's login. Each only shows when available; the token form stays as a fallback.
 */
function githubQuickLogin(onChange: () => void, tokenButton: HTMLButtonElement): HTMLElement {
  const box = el("div", undefined, "quick-login");
  const status = el("p", "", "status");
  const actions = el("div", undefined, "actions");
  box.append(actions, status);

  const signIn = button(
    "Sign in with GitHub",
    () =>
      void busy(signIn, status, async () => {
        const code = await api().githubDeviceStart();
        const waiting = el("div", undefined, "device-code");
        const cancel = button("Cancel", () => void api().githubDeviceCancel());
        waiting.append(
          el("p", "Your browser opened GitHub. Enter this code there, then approve:"),
          el("strong", code.userCode, "code"),
          link(code.verificationUri, code.verificationUri),
          el("p", "Waiting for GitHub…", "muted"),
          cancel,
        );
        actions.hidden = true;
        box.prepend(waiting);
        try {
          update({ accounts: await api().githubDeviceWait() });
          onChange();
        } finally {
          waiting.remove();
          actions.hidden = false;
        }
      }),
    "primary",
  );
  const cli = button(
    "Use my GitHub CLI login",
    () =>
      void busy(cli, status, async () => {
        update({ accounts: await api().githubCliLogin() });
        onChange();
      }),
  );

  box.hidden = true;
  loginOptions ??= api().githubLoginOptions();
  void loginOptions.then((options) => {
    if (options.deviceFlow) actions.append(signIn);
    if (options.githubCli) actions.append(cli);
    if (!options.deviceFlow && !options.githubCli) return;
    box.hidden = false;
    tokenButton.textContent = "Use a token instead…";
  });
  return box;
}

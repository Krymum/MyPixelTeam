import type { HooksStatus } from "../../../shared/work/types";
import { busy, button, el } from "../dom";
import { t } from "../i18n";

/**
 * Claude Code hooks, one click instead of `npm run setup:claude`. Optional: transcripts
 * already show agents; hooks add what they can't (waiting for you, session ends).
 */

const api = () => window.office.work;

export function hooksCard(): HTMLElement {
  const card = el("div", undefined, "card");
  const body = el("div", undefined, "account-form");
  const status = el("p", "", "status");
  card.append(
    el("h4", t("Live signals from Claude Code (optional)")),
    el(
      "p",
      t(
        'Hooks tell the office when an agent waits for you or ends its session, and enable the "waiting for you" notification. They run in the background and never slow Claude Code down.',
      ),
      "muted",
    ),
    body,
    status,
  );

  const show = (state: HooksStatus) => {
    const where = el(
      "small",
      t("In {path}; your own hooks are kept and a backup is made.", { path: state.settingsPath }),
      "muted",
    );
    const action = (label: string, run: () => Promise<HooksStatus>, className?: string) => {
      const b = button(label, () => void busy(b, status, async () => show(await run())), className);
      return b;
    };
    const actions = el("div", undefined, "actions");
    if (!state.installed)
      actions.append(action(t("Install hooks"), () => api().installHooks(), "primary"));
    else {
      if (state.outdated)
        actions.append(action(t("Update hooks"), () => api().installHooks(), "primary"));
      actions.append(action(t("Remove hooks"), () => api().uninstallHooks()));
    }
    const line = state.installed
      ? el(
          "p",
          state.outdated
            ? t("Installed, but pointing at another copy of the app.")
            : t("✓ Installed. New Claude Code sessions use them; restart running ones."),
          state.outdated ? "bad" : "ok",
        )
      : el("p", t("Not installed."), "muted");
    body.replaceChildren(line);
    if (!state.node.ok) {
      body.append(el("p", state.node.detail, "bad"));
      if (!state.installed) return;
    }
    body.append(actions, where);
  };

  body.append(el("p", t("Checking…"), "muted"));
  void busy(undefined, status, async () => show(await api().hooksStatus()));
  return card;
}

import { app, Notification, type BrowserWindow } from "electron";
import type { OfficeEvent } from "../../shared/protocol/schema";
import type { RunView } from "../../shared/work/types";
import { runNotice, waitingNotice, type Notice, type NoticeLanguage } from "./notices";

/**
 * Desktop notifications, so agents can be left alone: a run that ends, or an agent that
 * waits for an answer. Shown only while the office window is not in front.
 */

/** One "waiting" notification per agent per minute is plenty. */
const WAITING_QUIET_MS = 60_000;

/** The system's language: the one picked in the app's settings lives in the window. */
const language = (): NoticeLanguage =>
  (app.getPreferredSystemLanguages()[0] ?? app.getLocale()).toLowerCase().startsWith("fr")
    ? "fr"
    : "en";

export class Notifier {
  private readonly lastWaiting = new Map<string, number>();

  constructor(
    private readonly options: {
      enabled: () => boolean;
      window: () => BrowserWindow | null;
      /** Clicked a run notification. */
      openIssue: (run: RunView) => void;
    },
  ) {}

  run(run: RunView): void {
    const notice = runNotice(run, language());
    if (notice) this.show(notice, () => this.options.openIssue(run));
  }

  /** `run`: the agent works on a ticket; clicking opens it, where the question is answered. */
  event(event: OfficeEvent, run?: RunView): void {
    const notice = waitingNotice(event, language());
    if (!notice) return;
    const now = Date.now();
    if (now - (this.lastWaiting.get(event.agentId) ?? 0) < WAITING_QUIET_MS) return;
    this.lastWaiting.set(event.agentId, now);
    this.show(notice, run && (() => this.options.openIssue(run)));
  }

  private show(notice: Notice, onClick?: () => void): void {
    const win = this.options.window();
    if (!this.options.enabled() || !Notification.isSupported()) return;
    if (win?.isFocused()) return;
    win?.flashFrame(true);
    const n = new Notification({ ...notice, silent: false });
    n.on("click", () => {
      if (win?.isMinimized()) win.restore();
      win?.show();
      win?.focus();
      onClick?.();
    });
    n.show();
  }
}

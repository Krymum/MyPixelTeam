import { Notification, type BrowserWindow } from "electron";
import type { OfficeEvent } from "../../shared/protocol/schema";
import type { RunView } from "../../shared/work/types";
import { runNotice, waitingNotice, type Notice } from "./notices";

/**
 * Desktop notifications, so agents can be left alone: a run that ends, or an agent that
 * waits for an answer. Shown only while the office window is not in front.
 */

/** One "waiting" notification per agent per minute is plenty. */
const WAITING_QUIET_MS = 60_000;

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
    const notice = runNotice(run);
    if (notice) this.show(notice, () => this.options.openIssue(run));
  }

  event(event: OfficeEvent): void {
    const notice = waitingNotice(event);
    if (!notice) return;
    const now = Date.now();
    if (now - (this.lastWaiting.get(event.agentId) ?? 0) < WAITING_QUIET_MS) return;
    this.lastWaiting.set(event.agentId, now);
    this.show(notice);
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

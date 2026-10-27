import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OfficeEvent } from "../shared/protocol/schema";
import type { RunView } from "../shared/work/types";
import { IPC, WORK_CALLS, type OfficeApi, type WorkApi } from "./api";

/** Electron prefixes errors from the main process; keep only the service's message. */
async function call(channel: string, args: unknown[]): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(`work:${channel}`, ...args);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    throw new Error(text.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ""), {
      cause: err,
    });
  }
}

const calls = Object.fromEntries(
  WORK_CALLS.map((name) => [name, (...args: unknown[]) => call(name, args)]),
) as unknown as Omit<WorkApi, "onRuns" | "onOpenIssue">;

const api: OfficeApi = {
  onEvent(listener) {
    const handler = (_: IpcRendererEvent, event: OfficeEvent) => listener(event);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.off(IPC.event, handler);
  },
  history: () => ipcRenderer.invoke(IPC.history),
  info: () => ipcRenderer.invoke(IPC.info),
  work: {
    ...calls,
    onRuns(listener) {
      const handler = (_: IpcRendererEvent, runs: RunView[]) => listener(runs);
      ipcRenderer.on(IPC.runs, handler);
      return () => ipcRenderer.off(IPC.runs, handler);
    },
    onOpenIssue(listener) {
      const handler = (_: IpcRendererEvent, projectId: string, key: string) =>
        listener(projectId, key);
      ipcRenderer.on(IPC.openIssue, handler);
      return () => ipcRenderer.off(IPC.openIssue, handler);
    },
  },
};

contextBridge.exposeInMainWorld("office", api);

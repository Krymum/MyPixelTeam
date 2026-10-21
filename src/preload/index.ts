import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OfficeEvent } from "../shared/protocol/schema";
import { IPC, type OfficeApi } from "./api";

const api: OfficeApi = {
  onEvent(listener) {
    const handler = (_: IpcRendererEvent, event: OfficeEvent) => listener(event);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.off(IPC.event, handler);
  },
  history: () => ipcRenderer.invoke(IPC.history),
  info: () => ipcRenderer.invoke(IPC.info),
};

contextBridge.exposeInMainWorld("office", api);

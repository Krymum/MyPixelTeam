import type { OfficeEvent } from "../shared/protocol/schema";

export const IPC = {
  event: "office:event",
  history: "office:history",
  info: "office:info",
} as const;

export interface ServerInfo {
  url: string;
  listening: boolean;
  error?: string;
  demo: boolean;
  configPath?: string;
  /** Why office.config.json was ignored, if it was. */
  configError?: string;
}

/** Surface exposed to the renderer as `window.office`. */
export interface OfficeApi {
  /** Subscribes to live events; returns an unsubscribe function. */
  onEvent(listener: (event: OfficeEvent) => void): () => void;
  /** Recent events, so a reloaded renderer can rebuild the office. */
  history(): Promise<OfficeEvent[]>;
  info(): Promise<ServerInfo>;
}

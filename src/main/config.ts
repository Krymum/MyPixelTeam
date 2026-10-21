import { existsSync, readFileSync, watchFile } from "node:fs";
import { z } from "zod";
import { DEFAULT_CONFIG, OfficeConfig } from "../shared/config/office-config";

export interface LoadedConfig {
  config: OfficeConfig;
  path: string;
  /** Set when the file exists but could not be used; defaults apply meanwhile. */
  error?: string;
}

export function loadConfig(path: string): LoadedConfig {
  if (!existsSync(path)) return { config: DEFAULT_CONFIG, path };
  try {
    const parsed = OfficeConfig.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return { config: parsed.data, path };
    return { config: DEFAULT_CONFIG, path, error: z.prettifyError(parsed.error) };
  } catch (err) {
    return {
      config: DEFAULT_CONFIG,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Reloads the config whenever the file changes on disk. */
export function watchConfig(path: string, onChange: (loaded: LoadedConfig) => void): void {
  watchFile(path, { interval: 1000 }, () => onChange(loadConfig(path)));
}

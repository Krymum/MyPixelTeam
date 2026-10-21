import type { OfficeEvent, Source } from "../protocol/schema";
import { normalizeClaudeCode } from "./claude-code";

/**
 * Turns one raw hook payload from a CLI into zero or more protocol events.
 * Must be pure and must never throw on unexpected input: return [] instead.
 */
export type Normalizer = (raw: unknown, now: Date) => OfficeEvent[];

/** Normalizers for POST /ingest/:source. */
export const normalizers: Partial<Record<Source, Normalizer>> = {
  "claude-code": normalizeClaudeCode,
};

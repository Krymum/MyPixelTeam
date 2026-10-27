import { AGENT_MODELS, DEFAULT_MODEL } from "../../../shared/work/types";
import { select } from "../dom";

export const MODEL_HINT =
  "Sonnet handles most tickets. Opus uses your Claude quota much faster: keep it for hard tickets. Haiku suits small, well-described ones.";

/** Sonnet, Opus or Haiku; a model typed by hand in an earlier version stays offered. */
export function modelSelect(value: string | undefined): HTMLSelectElement {
  const options: [string, string][] = AGENT_MODELS.map(([id, name]) => [
    id,
    id === DEFAULT_MODEL ? `${name} (default)` : name,
  ]);
  if (value && !options.some(([id]) => id === value)) options.push([value, value]);
  return select(options, value || DEFAULT_MODEL);
}

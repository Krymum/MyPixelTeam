import { z } from "zod";
import type { OfficeEvent } from "../protocol/schema";

/** Roles map 1:1 to rooms. */
export const ROLES = ["dev", "qa", "ops", "research"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

const Pattern = z.string().refine(
  (p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid regular expression" },
);

const MATCH_FIELDS = ["agentName", "source", "cwd", "sessionId"] as const;

export const RoleRule = z.object({
  /**
   * Case-insensitive regexes matched against the whole field. Every listed field must
   * match. `agentName` is the subagent type for Claude Code / Codex subagents.
   */
  match: z
    .object({
      agentName: Pattern,
      source: Pattern,
      cwd: Pattern,
      sessionId: Pattern,
    })
    .partial()
    .refine((m) => Object.keys(m).length > 0, { message: "match needs at least one field" }),
  role: Role,
});

export const OfficeConfig = z.object({
  $schema: z.string().optional(),
  defaultRole: Role.default("dev"),
  rules: z.array(RoleRule).default([]),
});

export type RoleRule = z.infer<typeof RoleRule>;
export type OfficeConfig = z.infer<typeof OfficeConfig>;

export const DEFAULT_CONFIG: OfficeConfig = OfficeConfig.parse({
  defaultRole: "dev",
  rules: [
    { match: { agentName: ".*(review|test|qa|lint|verif).*" }, role: "qa" },
    { match: { agentName: "explore|plan|.*(research|doc|search|guide).*" }, role: "research" },
    { match: { agentName: ".*(deploy|devops|infra|ops|release).*" }, role: "ops" },
    { match: { cwd: ".*[\\\\/](infra|ops|deploy|terraform|k8s)([\\\\/].*)?" }, role: "ops" },
  ],
});

/**
 * Builds the function that decides an agent's role: an explicit `role` on the event
 * wins, then the first matching rule, then `defaultRole`.
 */
export function createRoleResolver(config: OfficeConfig): (event: OfficeEvent) => Role | string {
  const rules = config.rules.map((rule) => ({
    role: rule.role,
    tests: MATCH_FIELDS.filter((f) => rule.match[f] !== undefined).map((field) => {
      const re = new RegExp(`^(?:${rule.match[field]})$`, "i");
      return (event: OfficeEvent) => re.test(event[field] ?? "");
    }),
  }));
  return (event) => {
    if (event.role) return event.role;
    return rules.find((r) => r.tests.every((test) => test(event)))?.role ?? config.defaultRole;
  };
}

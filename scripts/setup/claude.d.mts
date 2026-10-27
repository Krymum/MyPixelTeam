// Types for claude.mjs, which the app also uses to install the hooks from its setup guide.
// Settings files are free-form JSON, hence `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
export declare const CLAUDE_EVENTS: string[];
export declare function settingsPath(scope: "user" | "project", projectDir?: string): string;
export declare function isOurs(handler: unknown): boolean;
export declare function uninstall(settings: any): any;
export declare function install(settings: any, command: string): any;

/** "{key} opened a pull request" + { key: "#7" }: placeholders without a value stay. */
export const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));

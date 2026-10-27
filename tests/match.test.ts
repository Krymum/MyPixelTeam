import { describe, expect, it } from "vitest";
import { jiraKeysForRepo } from "../src/shared/work/match";

const projects = [
  { key: "BILL", name: "Billing" },
  { key: "CRM", name: "Customer Relations" },
  { key: "WEB", name: "Site Web Public" },
  { key: "OPS", name: "Opérations" },
];

describe("jiraKeysForRepo", () => {
  it("matches a project's key or name in the repository name", () => {
    expect(jiraKeysForRepo("acme/billing-api", projects)).toEqual(["BILL"]);
    expect(jiraKeysForRepo("acme/crm-front", projects)[0]).toBe("CRM");
    expect(jiraKeysForRepo("acme/operations", projects)).toEqual(["OPS"]);
    expect(jiraKeysForRepo("acme/site-web-public", projects)[0]).toBe("WEB");
  });

  it("ranks an exact name above a shared word", () => {
    const both = [
      { key: "PAY", name: "Payments" },
      { key: "PAYAPP", name: "Payments App" },
    ];
    expect(jiraKeysForRepo("acme/payments-app", both)[0]).toBe("PAYAPP");
  });

  it("guesses nothing when nothing matches", () => {
    expect(jiraKeysForRepo("acme/infra", projects)).toEqual([]);
    expect(jiraKeysForRepo("acme/app", [])).toEqual([]);
  });
});

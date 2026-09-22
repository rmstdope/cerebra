import { describe, expect, it } from "vitest";
import { policyHash } from "../apps/server/src/registration.js";
import { validateConfig } from "../packages/core/src/config.js";
import { testConfig } from "./helpers.js";

describe("shared policy versus machine configuration", () => {
  it("allows different machine paths but detects decision-policy drift", () => {
    const a = testConfig("a");
    const b = testConfig("b");
    b.project.checkout = "/another/checkout";
    b.project.beadsDirectory = "/another/beads";
    expect(policyHash(a)).toBe(policyHash(b));
    b.project.requireCI = true;
    expect(policyHash(a)).not.toBe(policyHash(b));
  });
  it("refuses plaintext LAN UI exposure and duplicate agent IDs", () => {
    const config = testConfig();
    expect(() => validateConfig({ ...config, host: "0.0.0.0" })).toThrow("TLS");
    expect(() => validateConfig({ ...config, agents: [config.agents[0], config.agents[0]] })).toThrow("unique");
    expect(() => validateConfig({ ...config, project: { ...config.project, unknownApprovalOption: true } })).toThrow("Unrecognized");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEligibility270InputFromContext } from "@/lib/clearinghouse/buildEligibility270InputFromContext";
import { pickEligibilityAdapter } from "@/lib/clearinghouse/pickEligibilityAdapter";

const baseConnection = {
  id: "conn-1",
  organization_id: "org-1",
  mode: "test" as const,
  submitter_id: "SUB001",
  submitter_name: "Demo Clinic",
  submitter_contact_phone: "5551234567",
  submitter_contact_email: "billing@example.com",
};

const baseClient = {
  first_name: "Jane",
  last_name: "Doe",
  date_of_birth: "1985-04-12",
};

const basePolicy = {
  payer_id: "BCBS001",
  plan_name: "Blue Cross PPO",
  subscriber_id: "ABC123456",
  policy_number: null,
};

describe("buildEligibility270InputFromContext", () => {
  it("projects connection + client + policy into a valid Eligibility270Input", () => {
    const input = buildEligibility270InputFromContext({
      connection: baseConnection,
      client: baseClient,
      policy: basePolicy,
      serviceTypeCodes: ["30"],
      serviceDate: "2026-06-01",
    });

    assert.equal(input.connection.mode, "test");
    assert.equal(input.connection.isa_usage_indicator, "T");
    assert.equal(input.connection.receiver_id, "030240928");
    assert.equal(input.connection.receiver_name, "Availity");
    assert.equal(input.connection.sender_qualifier, "ZZ");
    assert.equal(input.connection.receiver_qualifier, "ZZ");
    assert.equal(input.connection.gs_receiver_code, "030240928");
    assert.equal(input.connection.x12_version, "005010X279A1");
    assert.equal(input.connection.submitter_id, "SUB001");
    assert.equal(input.connection.submitter_contact_phone, "5551234567");

    assert.equal(input.informationSource.payerId, "BCBS001");
    assert.equal(input.informationSource.payerName, "Blue Cross PPO");

    assert.equal(input.subscriber.firstName, "Jane");
    assert.equal(input.subscriber.lastName, "Doe");
    assert.equal(input.subscriber.memberId, "ABC123456");
    assert.equal(input.subscriber.dob, "1985-04-12");

    assert.deepEqual(input.serviceTypeCodes, ["30"]);
    assert.equal(input.serviceDate, "2026-06-01");
  });

  it("flips ISA15 to 'P' when mode is production/live", () => {
    const live = buildEligibility270InputFromContext({
      connection: { ...baseConnection, mode: "live" },
      client: baseClient,
      policy: basePolicy,
      serviceTypeCodes: ["98"],
    });
    assert.equal(live.connection.mode, "production");
    assert.equal(live.connection.isa_usage_indicator, "P");
  });

  it("falls back to policy_number when subscriber_id is missing", () => {
    const input = buildEligibility270InputFromContext({
      connection: baseConnection,
      client: baseClient,
      policy: { ...basePolicy, subscriber_id: null, policy_number: "POL999" },
      serviceTypeCodes: ["98"],
    });
    assert.equal(input.subscriber.memberId, "POL999");
  });

  it("defaults service type codes to ['98'] when empty", () => {
    const input = buildEligibility270InputFromContext({
      connection: baseConnection,
      client: baseClient,
      policy: basePolicy,
      serviceTypeCodes: [],
    });
    assert.deepEqual(input.serviceTypeCodes, ["98"]);
  });

  it("defaults to test mode when connection.mode is missing or unknown", () => {
    const input = buildEligibility270InputFromContext({
      connection: { ...baseConnection, mode: null },
      client: baseClient,
      policy: basePolicy,
      serviceTypeCodes: ["98"],
    });
    assert.equal(input.connection.mode, "test");
    assert.equal(input.connection.isa_usage_indicator, "T");
  });

  it("honors provider override when supplied", () => {
    const input = buildEligibility270InputFromContext({
      connection: baseConnection,
      client: baseClient,
      policy: basePolicy,
      serviceTypeCodes: ["98"],
      provider: { npi: "1234567890", lastNameOrOrg: "Smith", firstName: "John" },
    });
    assert.equal(input.informationReceiver.npi, "1234567890");
    assert.equal(input.informationReceiver.lastNameOrOrg, "Smith");
    assert.equal(input.informationReceiver.firstName, "John");
    assert.equal(input.informationReceiver.entityType, "1");
  });
});

describe("pickEligibilityAdapter", () => {
  it("returns the Availity SOAP adapter for vendor='availity'", () => {
    const adapter = pickEligibilityAdapter({ vendor: "availity" });
    assert.equal(adapter.vendor, "availity");
  });

  it("returns the Mock adapter for any non-availity vendor", () => {
    assert.equal(pickEligibilityAdapter({ vendor: "mock" }).vendor, "mock");
    assert.equal(pickEligibilityAdapter({ vendor: null }).vendor, "mock");
    assert.equal(pickEligibilityAdapter({ vendor: "change_healthcare" }).vendor, "mock");
  });

  it("Mock adapter.runEligibilityCORE returns a persistence-compatible shape", async () => {
    const adapter = pickEligibilityAdapter({ vendor: "mock" });
    const input = buildEligibility270InputFromContext({
      connection: baseConnection,
      client: baseClient,
      policy: basePolicy,
      serviceTypeCodes: ["98"],
    });
    const result = await adapter.runEligibilityCORE(input);
    assert.ok(result.controlNumber.length > 0);
    assert.ok(result.correlationId.length > 0);
    assert.ok(result.rawRequest.includes("ISA*") || result.rawRequest.length > 0);
    assert.ok(result.rawResponse.includes("ST*271"));
    assert.equal(result.normalized.payerId, "BCBS001");
    assert.equal(result.normalized.memberId, "ABC123456");
  });
});

import type {
  OfficeAlly837PGenerationInput,
  OfficeAlly837PValidationError,
  OfficeAlly837PValidationResult,
} from "./types";

function pushError(
  errors: OfficeAlly837PValidationError[],
  field: string,
  message: string,
  loop?: string,
  segment?: string,
) {
  errors.push({ field, message, severity: "error", loop, segment });
}

function pushWarning(
  warnings: OfficeAlly837PValidationError[],
  field: string,
  message: string,
  loop?: string,
  segment?: string,
) {
  warnings.push({ field, message, severity: "warning", loop, segment });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTenDigitNpi(value: unknown): boolean {
  return typeof value === "string" && /^\d{10}$/.test(value.trim());
}

function isMoneyGreaterThanZero(value: unknown): boolean {
  const numericValue = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(numericValue) && numericValue > 0;
}

function isValidGender(value: unknown): value is "F" | "M" | "U" {
  return value === "F" || value === "M" || value === "U";
}

function isTwoCharModifier(value: unknown): boolean {
  return typeof value === "string" && value.trim().length === 2;
}

function isPoBoxAddress(value: string): boolean {
  return /\bP\.?\s*O\.?\s*BOX\b|\bPOBOX\b|\bPOST\s*OFFICE\s*BOX\b/i.test(value);
}

export function validateOfficeAlly837PClaim(
  input: OfficeAlly837PGenerationInput,
): OfficeAlly837PValidationResult {
  const errors: OfficeAlly837PValidationError[] = [];
  const warnings: OfficeAlly837PValidationError[] = [];

  const { connection, claim, serviceLines, parties, payerProfile } = input;

  if (!isNonEmptyString(connection.submitter_id)) {
    pushError(errors, "connection.submitter_id", "submitter_id is required.", "ISA/GS", "ISA");
  }

  if (!isNonEmptyString(connection.receiver_id)) {
    pushError(errors, "connection.receiver_id", "receiver_id is required.", "ISA/GS", "ISA");
  } else if (connection.receiver_id !== "330897513") {
    pushWarning(
      warnings,
      "connection.receiver_id",
      "Using an explicit Office Ally receiver_id override.",
      "ISA/GS",
      "ISA",
    );
  }

  if (!isNonEmptyString(connection.receiver_name)) {
    pushError(errors, "connection.receiver_name", "receiver_name is required.", "ISA/GS", "1000B");
  } else if (connection.receiver_name.toUpperCase() !== "OFFICEALLY") {
    pushWarning(
      warnings,
      "connection.receiver_name",
      "Using an explicit Office Ally receiver_name override.",
      "ISA/GS",
      "1000B",
    );
  }

  if (connection.x12_version !== "005010X222A1") {
    pushError(errors, "connection.x12_version", "x12_version must be 005010X222A1.", "ISA/GS", "GS");
  }

  const expectedIsa15 = connection.mode === "test" ? "T" : "P";
  if (connection.isa_usage_indicator !== expectedIsa15) {
    pushError(
      errors,
      "connection.isa_usage_indicator",
      `ISA usage indicator must be ${expectedIsa15} for ${connection.mode} mode.`,
      "ISA",
      "ISA",
    );
  }

  if (!isNonEmptyString(payerProfile.payer_name)) {
    pushError(errors, "payerProfile.payer_name", "payer_name is required.", "2010BB", "NM1");
  }

  if (!isNonEmptyString(payerProfile.office_ally_payer_id)) {
    pushError(errors, "payerProfile.office_ally_payer_id", "payer_id is required.", "2010BB", "NM1");
  } else if (payerProfile.office_ally_payer_id.trim().length !== 5) {
    pushWarning(
      warnings,
      "payerProfile.office_ally_payer_id",
      "Office Ally payer IDs are typically 5 characters.",
      "2010BB",
      "NM1",
    );
  }

  if (!isNonEmptyString(parties.billing_provider_name)) {
    pushError(errors, "parties.billing_provider_name", "billing_provider_name is required.", "2010AA", "NM1");
  }

  if (!isTenDigitNpi(parties.billing_provider_npi)) {
    pushError(errors, "parties.billing_provider_npi", "billing_provider_npi must be exactly 10 digits.", "2010AA", "NM1");
  }

  if (!isNonEmptyString(parties.billing_provider_tax_id)) {
    pushError(errors, "parties.billing_provider_tax_id", "billing_provider_tax_id is required.", "2010AA", "REF");
  }

  if (parties.billing_provider_tax_id_type !== "EI" && parties.billing_provider_tax_id_type !== "SY") {
    pushError(
      errors,
      "parties.billing_provider_tax_id_type",
      "billing_provider_tax_id_type must be EI or SY.",
      "2010AA",
      "REF",
    );
  }

  if (!isNonEmptyString(parties.billing_provider_address1)) {
    pushError(errors, "parties.billing_provider_address1", "billing_provider_address1 is required.", "2010AA", "N3");
  } else if (isPoBoxAddress(parties.billing_provider_address1)) {
    pushError(
      errors,
      "parties.billing_provider_address1",
      "Billing provider address must be a physical address, not a PO Box.",
      "2010AA",
      "N3",
    );
  }

  if (!isNonEmptyString(parties.billing_provider_city)) {
    pushError(errors, "parties.billing_provider_city", "billing_provider_city is required.", "2010AA", "N4");
  }

  if (!isNonEmptyString(parties.billing_provider_state) || parties.billing_provider_state.trim().length !== 2) {
    pushError(errors, "parties.billing_provider_state", "billing_provider_state must be 2 characters.", "2010AA", "N4");
  }

  if (!isNonEmptyString(parties.billing_provider_zip)) {
    pushError(errors, "parties.billing_provider_zip", "billing_provider_zip is required.", "2010AA", "N4");
  }

  if (!isNonEmptyString(parties.subscriber_last_name)) {
    pushError(errors, "parties.subscriber_last_name", "subscriber_last_name is required.", "2010BA", "NM1");
  }

  if (!isNonEmptyString(parties.subscriber_first_name)) {
    pushError(errors, "parties.subscriber_first_name", "subscriber_first_name is required.", "2010BA", "NM1");
  }

  if (!isNonEmptyString(parties.subscriber_member_id)) {
    pushError(errors, "parties.subscriber_member_id", "subscriber_member_id is required.", "2010BA", "NM1");
  }

  if (!isNonEmptyString(parties.subscriber_dob)) {
    pushError(errors, "parties.subscriber_dob", "subscriber_dob is required.", "2010BA", "DMG");
  }

  if (!isNonEmptyString(parties.subscriber_address1)) {
    pushError(errors, "parties.subscriber_address1", "subscriber_address1 is required.", "2010BA", "N3");
  }

  if (!isNonEmptyString(parties.subscriber_city)) {
    pushError(errors, "parties.subscriber_city", "subscriber_city is required.", "2010BA", "N4");
  }

  if (!isNonEmptyString(parties.subscriber_state) || parties.subscriber_state.trim().length !== 2) {
    pushError(errors, "parties.subscriber_state", "subscriber_state must be 2 characters.", "2010BA", "N4");
  }

  if (!isNonEmptyString(parties.subscriber_zip)) {
    pushError(errors, "parties.subscriber_zip", "subscriber_zip is required.", "2010BA", "N4");
  }

  if (parties.subscriber_gender !== undefined && parties.subscriber_gender !== null && !isValidGender(parties.subscriber_gender)) {
    pushError(errors, "parties.subscriber_gender", "subscriber_gender must be F, M, or U.", "2010BA", "DMG");
  }

  if (claim.patient_account_number == null || String(claim.patient_account_number).trim().length === 0) {
    pushError(errors, "claim.patient_account_number", "patient_account_number is required.", "2300", "CLM");
  }

  if (!isNonEmptyString(claim.place_of_service) && !serviceLines.some((line) => isNonEmptyString(line.place_of_service))) {
    pushError(
      errors,
      "claim.place_of_service",
      "place_of_service is required at the claim level or on at least one service line.",
      "2300/2400",
      "CLM/SV1",
    );
  }

  if (!Array.isArray(claim.diagnosis_codes) || claim.diagnosis_codes.filter((code) => isNonEmptyString(code)).length === 0) {
    pushError(errors, "claim.diagnosis_codes", "At least one diagnosis code is required.", "2300", "HI");
  }

  if (!Array.isArray(serviceLines) || serviceLines.length === 0) {
    pushError(errors, "serviceLines", "At least one service line is required.", "2400", "LX/SV1");
  }

  if (!isMoneyGreaterThanZero(claim.total_charge)) {
    pushError(errors, "claim.total_charge", "total charge must be greater than 0.", "2300", "CLM");
  }

  if (!isNonEmptyString(connection.submitter_id)) {
    pushError(errors, "connection.submitter_id", "submitter_id is required.", "1000A", "NM1");
  }

  if (claim.claim_status && claim.claim_status !== "draft" && claim.claim_status !== "ready_for_validation" && claim.claim_status !== "validation_failed" && claim.claim_status !== "ready_for_batch" && claim.claim_status !== "batched") {
    pushWarning(
      warnings,
      "claim.claim_status",
      `Claim status ${claim.claim_status} will be preserved by the generator, but the claim is not in a pre-batch state.`,
      "CLAIM",
    );
  }

  const diagnosisCodes = (claim.diagnosis_codes ?? []).filter((code): code is string => isNonEmptyString(code));
  const diagnosisCount = diagnosisCodes.length;

  serviceLines.forEach((line, index) => {
    const row = index + 1;

    if (!isNonEmptyString(line.service_date_from)) {
      pushError(errors, `serviceLines[${index}].service_date_from`, `service_date_from is required for service line ${row}.`, "2400", "DTP");
    }

    if (!isNonEmptyString(line.procedure_code)) {
      pushError(errors, `serviceLines[${index}].procedure_code`, `procedure_code is required for service line ${row}.`, "2400", "SV1");
    }

    if (!isMoneyGreaterThanZero(line.charge_amount)) {
      pushError(errors, `serviceLines[${index}].charge_amount`, `charge_amount must be greater than 0 for service line ${row}.`, "2400", "SV1");
    }

    if (!isMoneyGreaterThanZero(line.units)) {
      pushError(errors, `serviceLines[${index}].units`, `units must be greater than 0 for service line ${row}.`, "2400", "SV1");
    }

    if (!Array.isArray(line.diagnosis_pointers) || line.diagnosis_pointers.length === 0) {
      pushError(errors, `serviceLines[${index}].diagnosis_pointers`, `diagnosis_pointers are required for service line ${row}.`, "2400", "SV1");
    } else {
      line.diagnosis_pointers.forEach((pointer, pointerIndex) => {
        const normalizedPointer = Number(pointer);
        if (!Number.isInteger(normalizedPointer) || normalizedPointer < 1 || normalizedPointer > diagnosisCount) {
          pushError(
            errors,
            `serviceLines[${index}].diagnosis_pointers[${pointerIndex}]`,
            `Diagnosis pointer ${pointer} on service line ${row} must reference an existing diagnosis index.`,
            "2400",
            "SV1",
          );
        }
      });
    }

    if (Array.isArray(line.modifiers)) {
      line.modifiers.forEach((modifier, modifierIndex) => {
        if (!isTwoCharModifier(modifier)) {
          pushError(
            errors,
            `serviceLines[${index}].modifiers[${modifierIndex}]`,
            `Modifier ${modifier} on service line ${row} must be exactly 2 characters.`,
            "2400",
            "SV1",
          );
        }
      });
    }

    if (line.rendering_provider_npi !== undefined && line.rendering_provider_npi !== null && line.rendering_provider_npi !== "" && !isTenDigitNpi(line.rendering_provider_npi)) {
      pushError(
        errors,
        `serviceLines[${index}].rendering_provider_npi`,
        `rendering_provider_npi on service line ${row} must be exactly 10 digits when present.`,
        "2310B/2400",
        "NM1",
      );
    }
  });

  if (claim.accept_assignment !== undefined && claim.accept_assignment !== null) {
    // No-op; the generator will emit the claim as accepted assignment unless a future workflow overrides it.
  }

  if (claim.release_of_information !== undefined && claim.release_of_information !== null) {
    // No-op; preserved in the generator as Y/N.
  }

  if (claim.signature_on_file !== undefined && claim.signature_on_file !== null) {
    // No-op; preserved in the generator as Y/N.
  }

  if (claim.patient_id != null && parties.patient_is_subscriber === false) {
    if (!isNonEmptyString(parties.patient_last_name)) {
      pushError(errors, "parties.patient_last_name", "patient_last_name is required when patient_is_subscriber is false.", "2010CA", "NM1");
    }
    if (!isNonEmptyString(parties.patient_first_name)) {
      pushError(errors, "parties.patient_first_name", "patient_first_name is required when patient_is_subscriber is false.", "2010CA", "NM1");
    }
    if (!isNonEmptyString(parties.patient_dob)) {
      pushError(errors, "parties.patient_dob", "patient_dob is required when patient_is_subscriber is false.", "2010CA", "DMG");
    }
    if (!isValidGender(parties.patient_gender)) {
      pushError(errors, "parties.patient_gender", "patient_gender must be F, M, or U when patient_is_subscriber is false.", "2010CA", "DMG");
    }
    if (!isNonEmptyString(parties.patient_address1)) {
      pushError(errors, "parties.patient_address1", "patient_address1 is required when patient_is_subscriber is false.", "2010CA", "N3");
    }
    if (!isNonEmptyString(parties.patient_city)) {
      pushError(errors, "parties.patient_city", "patient_city is required when patient_is_subscriber is false.", "2010CA", "N4");
    }
    if (!isNonEmptyString(parties.patient_state) || parties.patient_state.trim().length !== 2) {
      pushError(errors, "parties.patient_state", "patient_state must be 2 characters when patient_is_subscriber is false.", "2010CA", "N4");
    }
    if (!isNonEmptyString(parties.patient_zip)) {
      pushError(errors, "parties.patient_zip", "patient_zip is required when patient_is_subscriber is false.", "2010CA", "N4");
    }
  }

  if (!parties.patient_is_subscriber) {
    pushWarning(
      warnings,
      "parties.patient_is_subscriber",
      "Patient loop 2010CA will be generated because the patient differs from the subscriber.",
      "2010CA",
    );
  }

  if (parties.rendering_same_as_billing === false) {
    if (!isNonEmptyString(parties.rendering_provider_last_name_or_org)) {
      pushError(errors, "parties.rendering_provider_last_name_or_org", "rendering provider name is required when rendering_same_as_billing is false.", "2310B", "NM1");
    }
    if (!isTenDigitNpi(parties.rendering_provider_npi)) {
      pushError(errors, "parties.rendering_provider_npi", "rendering provider NPI is required and must be 10 digits when rendering_same_as_billing is false.", "2310B", "NM1");
    }
    if (parties.rendering_provider_entity_type === "1" && !isNonEmptyString(parties.rendering_provider_first_name)) {
      pushError(errors, "parties.rendering_provider_first_name", "rendering_provider_first_name is required when entity type is 1.", "2310B", "NM1");
    }
  }

  if (parties.service_facility_same_as_billing === false) {
    if (!isNonEmptyString(parties.service_facility_name)) {
      pushError(errors, "parties.service_facility_name", "service_facility_name is required when service_facility_same_as_billing is false.", "2310C", "NM1");
    }
    if (!isNonEmptyString(parties.service_facility_address1)) {
      pushError(errors, "parties.service_facility_address1", "service_facility_address1 is required when service_facility_same_as_billing is false.", "2310C", "N3");
    }
    if (!isNonEmptyString(parties.service_facility_city)) {
      pushError(errors, "parties.service_facility_city", "service_facility_city is required when service_facility_same_as_billing is false.", "2310C", "N4");
    }
    if (!isNonEmptyString(parties.service_facility_state) || parties.service_facility_state.trim().length !== 2) {
      pushError(errors, "parties.service_facility_state", "service_facility_state must be 2 characters when service_facility_same_as_billing is false.", "2310C", "N4");
    }
    if (!isNonEmptyString(parties.service_facility_zip)) {
      pushError(errors, "parties.service_facility_zip", "service_facility_zip is required when service_facility_same_as_billing is false.", "2310C", "N4");
    }
  }

  if (parties.service_facility_npi && !isTenDigitNpi(parties.service_facility_npi)) {
    pushError(errors, "parties.service_facility_npi", "service_facility_npi must be exactly 10 digits when present.", "2310C", "NM1");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

# FHIR R4 API (minimal)

Small, outward-facing FHIR R4 surface for TherassistantEHR. Enough to power
referrals, patient apps, and health-system partners doing read-only clinical
context lookups — and to pass a basic HAPI validator round-trip.

## Base URL

```
/api/fhir/R4
```

All responses use `Content-Type: application/fhir+json; charset=utf-8`.

## Supported resources

| Resource          | Read | Search | Backed by                                                            |
|-------------------|------|--------|----------------------------------------------------------------------|
| Patient           | ✓    | ✓      | `clients`                                                            |
| Practitioner      | ✓    | ✓      | `staff_profiles` (+ optional `provider_profiles` join on `staff_id`) |
| Encounter         | ✓    | ✓      | `encounters`                                                         |
| Observation       | ✓    | ✓      | `patient_check_ins` (mood / stressors / safety / psychosocial)       |
| Appointment       | ✓    | ✓      | `appointments`                                                       |
| Coverage          | ✓    | ✓      | `intake_submissions.insurance` (jsonb)                               |
| DocumentReference | ✓    | ✓      | `documents`                                                          |

### CapabilityStatement

```
GET /api/fhir/R4/metadata
```

Returns a FHIR `CapabilityStatement` describing every resource and search
parameter this server supports.

## Common conventions

Every list endpoint returns a `Bundle` of `type: searchset` with `total`,
`link[].self`, and `entry[].resource` / `entry[].search.mode = "match"`.
Detail endpoints return the bare resource, or a FHIR `OperationOutcome`
with HTTP 404 / 4xx / 5xx on failure.

Shared pagination parameters:

| Param      | Type   | Default | Range          |
|------------|--------|---------|----------------|
| `_count`   | number | 20      | 1..200         |
| `_offset`  | number | 0       | 0..100000      |

Reference search params (`patient`, `practitioner`, `beneficiary`) accept
either a bare id (`abc-123`) or the FHIR typed form (`Patient/abc-123`).
Date search params expect `YYYY-MM-DD` and do an exact-day match.

## Resource specifics

### Patient

```
GET /api/fhir/R4/Patient/{id}
GET /api/fhir/R4/Patient?identifier=&name=&family=&given=&birthdate=YYYY-MM-DD
```

Mapping: `identifier` (MRN + external id), `active`, `name` (official + usual),
`gender`, `birthDate`, `telecom`, `address`, `deceasedDateTime`.

### Practitioner

```
GET /api/fhir/R4/Practitioner/{id}
GET /api/fhir/R4/Practitioner?identifier=<NPI>&name=&family=&given=
```

Mapping: `identifier` (NPI when present, with NPI v2-0203 type coding),
`active` (false when archived / inactive), `name`, `telecom` (email + phone),
`qualification` (credentials, specialty, job title, license). Source row is
`staff_profiles`; if a matching `provider_profiles` row exists for the same
`staff_id`, NPI / specialty / credentials / license are taken from there.

### Encounter

```
GET /api/fhir/R4/Encounter/{id}
GET /api/fhir/R4/Encounter?patient=&date=YYYY-MM-DD&status=
```

Mapping: `status` (translated from `encounter_status`), `class` (always
ambulatory for now), `subject` → Patient, optional `participant` → Practitioner,
`period` from `started_at` / `ended_at`, optional `appointment` link,
`reasonCode.text` from `session_summary` (truncated).

### Observation

```
GET /api/fhir/R4/Observation/{id}
GET /api/fhir/R4/Observation?patient=&date=YYYY-MM-DD
```

Mapping: one Observation per `patient_check_ins` row, with
`category = survey`, `code = "Patient check-in"`, `subject` → Patient,
optional `encounter` → Encounter, `effectiveDateTime` / `issued` from
`submitted_at`, and a `component[]` array with `valueString` for each populated
check-in field (mood, stressors, safety, psychosocial). The patient's free-text
statement, when present, lands in `note[]`.

### Appointment

```
GET /api/fhir/R4/Appointment/{id}
GET /api/fhir/R4/Appointment?patient=&practitioner=&date=YYYY-MM-DD&status=
```

Mapping: `status` (translated from `appointment_status`), `serviceType.text`
from `appointment_type`, `description` from `reason`, `start` / `end` from
`scheduled_start_at` / `scheduled_end_at`, two required participants (Patient
+ Practitioner when present), optional `cancelationReason.text`.

### Coverage

```
GET /api/fhir/R4/Coverage/{id}
GET /api/fhir/R4/Coverage?beneficiary=    (alias: patient=)
```

Mapping: derived from `intake_submissions.insurance` (jsonb captured during
patient intake). The mapper pulls a small set of well-known keys —
`payerName`, `memberId`, `planName`, `relationship`, `effectiveDate`,
`terminationDate` (with common camelCase / snake_case variants). Submissions
without any recognisable insurance data still surface a Coverage with
`status: draft` so partners know an intake happened.

### DocumentReference

```
GET /api/fhir/R4/DocumentReference/{id}
GET /api/fhir/R4/DocumentReference?patient=&type=
```

Mapping: `status` (`current` or `entered-in-error` when archived), `type.text`
from `document_type`, `category.text` from `document_scope`, `subject` →
Patient (when present), `description` from the admin-set `title` (never from
the free-text `notes` field), single `content[].attachment` with
`contentType`, `title`, `size`, `creation`, and a truly opaque
`urn:ehr:document:<id>` URL.

Raw Supabase Storage `bucket` / `storage_path` / `file_name` / `notes` are
**never** surfaced through FHIR — they can contain identifying PHI. A future
signed-URL download endpoint will resolve the opaque URN back to a fetchable
URL after re-checking auth and scopes.

## Auth & org scoping

Every protected FHIR endpoint goes through the same `requireAuthentication`
middleware the rest of the EHR APIs use — unauthenticated → `OperationOutcome`
HTTP 401; inactive staff → 403. The organization id is **always** taken from
the authenticated staff session, never from a query parameter or body, so an
outside caller cannot pivot organizations by changing a URL.

`GET /api/fhir/R4/metadata` is intentionally unauthenticated — the
CapabilityStatement is the standard discovery document and contains no PHI.

Public partner-facing access (SMART-on-FHIR, OAuth scopes, Bulk Data) is a
follow-up. When that lands, update this README with the new auth contract.

## What is intentionally not here

- Other resources (Condition, MedicationRequest, AllergyIntolerance,
  ServiceRequest, Claim, ExplanationOfBenefit, …)
- Write operations (`POST`, `PUT`, `PATCH`)
- SMART-on-FHIR / Bulk Data export
- A separate public/partner endpoint with its own auth
- Signed-URL fetch for `DocumentReference.content.attachment.url`

Each is a separate follow-up task.

## Validating against the HAPI validator

```
curl -sS "$BASE/api/fhir/R4/Encounter/<id>" \
  -H 'accept: application/fhir+json' \
  > encounter.json
curl -sS -X POST 'https://validator.fhir.org/validate' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @encounter.json
```

A small Node script that builds one synthetic happy-path example per resource
and posts it to `https://hapi.fhir.org/baseR4/{ResourceType}/$validate` lives
at `scripts/validate-fhir-fixtures.ts`. Run it with:

```
pnpm --filter @workspace/therassistant-ehr exec tsx scripts/validate-fhir-fixtures.ts
```

All six new resources (Practitioner, Encounter, Observation, Appointment,
Coverage, DocumentReference) currently pass with warnings only.

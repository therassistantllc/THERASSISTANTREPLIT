# FHIR R4 API (minimal)

Small, outward-facing FHIR R4 surface for TherassistantEHR. This is the
foundation for future referrals, patient apps, and health-system partners —
just enough to prove the pattern and pass a basic validator.

## Base URL

```
/api/fhir/R4
```

All responses use `Content-Type: application/fhir+json; charset=utf-8`.

## Supported resources

| Resource | Read | Search |
|----------|------|--------|
| Patient  | ✓    | ✓      |

### CapabilityStatement

```
GET /api/fhir/R4/metadata
```

Returns a FHIR `CapabilityStatement` describing what this server supports.

### Patient read

```
GET /api/fhir/R4/Patient/{id}
```

Returns a single FHIR R4 `Patient` resource built from the EHR's `clients`
row. Returns a FHIR `OperationOutcome` with HTTP 404 if the patient does not
exist in the active organization.

The mapping covers:

- `identifier` — MRN (and external client reference as a secondary id)
- `active` — false when the client is archived or deceased
- `name` — official (given + family) and `usual` for preferred name
- `gender` — derived from `gender_identity` then `sex_at_birth`
- `birthDate` — `date_of_birth`
- `telecom` — phone, email
- `address` — home physical address
- `deceasedDateTime` — when present

### Patient search

```
GET /api/fhir/R4/Patient?identifier=...&name=...&family=...&given=...&birthdate=YYYY-MM-DD&_count=20&_offset=0
```

Returns a FHIR `Bundle` of `type: searchset` with `total` and `entry[]`,
each containing `fullUrl` and the matching `Patient` resource.

`identifier` accepts either a bare value or the FHIR `system|value` form.

## Auth & org scoping

For the first cut, the FHIR surface is gated by the same application auth as
the rest of the EHR. The organization is resolved **server-side** from the
configured `ORGANIZATION_ID` — query-string org ids are intentionally
ignored on these routes so an outside caller cannot pivot between
organizations by changing a URL parameter.

Public partner-facing access (SMART-on-FHIR, OAuth scopes, Bulk Data) is a
follow-up. When that lands, this README should be updated with the new auth
contract.

## What is intentionally not here

- Other resources (Practitioner, Encounter, Observation, Appointment,
  Coverage, Claim, DocumentReference)
- Write operations (`POST`, `PUT`, `PATCH`)
- SMART-on-FHIR / Bulk Data export
- A separate public/partner endpoint with its own auth

Each is a separate follow-up task.

## Validating

To sanity-check a response against the official HAPI validator:

```
curl -sS "$BASE/api/fhir/R4/Patient/<id>" \
  -H 'accept: application/fhir+json' \
  > patient.json
curl -sS -X POST 'https://validator.fhir.org/validate' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @patient.json
```

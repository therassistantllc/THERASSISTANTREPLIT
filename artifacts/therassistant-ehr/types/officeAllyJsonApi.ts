// File: types/officeAllyJsonApi.ts

export type OfficeAllyCode = {
  codeValue?: string | null;
  description?: string | null;
};

export type OfficeAllyAAAError = {
  loopId?: string | null;
  loopName?: string | null;
  validRequestIndicator?: string | null;
  rejectReason?: OfficeAllyCode | null;
  followUpAction?: OfficeAllyCode | null;
};

export type OfficeAllyPayer = {
  name?: string | null;
  payerId?: string | null;
};

export type OfficeAllyAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  countryCode?: string | null;
};

export type OfficeAllyProvider = {
  npi?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  providerID?: string | null;
  medicaidPin?: string | null;
  providerCode?: string | null;
  taxonomyCode?: string | null;
  suffix?: string | null;
  address?: OfficeAllyAddress | null;
};

export type OfficeAllyPerson = {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  suffix?: string | null;
  dob?: string | null;
  dateOfBirth?: string | null;
  gender?: string | OfficeAllyCode | null;
  memberId?: string | null;
  address?: OfficeAllyAddress | null;
};

export type OfficeAllyEligibilityRequest = {
  payerId?: string | null;
  provider?: OfficeAllyProvider | null;
  requestingProvider?: OfficeAllyProvider | null;
  subscriber?: OfficeAllyPerson | null;
  dependent?: OfficeAllyPerson | null;
  serviceTypeCodes?: string[] | null;
  procedureCodes?: unknown[] | null;
  [key: string]: unknown;
};

export type OfficeAllyBenefitContent = {
  benefitInformationCode?: OfficeAllyCode | null;
  coverageLevel?: OfficeAllyCode | null;
  serviceTypeCodes?: OfficeAllyCode[] | null;
  insuranceTypeCode?: OfficeAllyCode | null;
  planCoverageDescription?: string | null;
  timePeriod?: OfficeAllyCode | null;
  monetaryAmount?: string | number | null;
  percent?: string | number | null;
  quantityType?: OfficeAllyCode | null;
  quantity?: string | number | null;
  requiresAuthorization?: OfficeAllyCode | null;
  networkIndicator?: OfficeAllyCode | null;
  messages?: string[] | null;
  benefitDates?: unknown;
  benefitDatesList?: unknown[] | null;
  placesOfService?: OfficeAllyCode[] | null;
  relatedEntities?: unknown[] | null;
  [key: string]: unknown;
};

export type OfficeAllyBenefitResponse = {
  plans?: OfficeAllyBenefitContent[] | null;
  benefits?: OfficeAllyBenefitContent[] | null;
  benefitDescriptions?: OfficeAllyBenefitContent[] | null;
  exclusions?: OfficeAllyBenefitContent[] | null;
  limitations?: OfficeAllyBenefitContent[] | null;
  entities?: OfficeAllyBenefitContent[] | null;
  preExistingConditions?: OfficeAllyBenefitContent[] | null;
  disclaimers?: OfficeAllyBenefitContent[] | null;
  otherPayers?: OfficeAllyBenefitContent[] | null;
  miscellaneous?: OfficeAllyBenefitContent[] | null;
  cannotProcess?: OfficeAllyBenefitContent[] | null;
  otherSourceOfData?: OfficeAllyBenefitContent[] | null;
};

export type OfficeAllyResponsePerson = OfficeAllyPerson & {
  memberId?: string | null;
  planName?: string | null;
  groupNumber?: string | null;
  groupName?: string | null;
  ebResponseDetails?: OfficeAllyBenefitResponse | null;
  [key: string]: unknown;
};

export type OfficeAllyEligibilityResponse = {
  responseStatus?: OfficeAllyCode | null;
  transactionId?: string | null;
  userId?: number | null;
  oaPayer?: OfficeAllyPayer | null;
  transactionErrors?: OfficeAllyAAAError[] | null;
  responsePayer?: OfficeAllyPayer | null;
  requestingProvider?: unknown;
  subscriber?: OfficeAllyResponsePerson | null;
  dependent?: OfficeAllyResponsePerson | null;
  x12?: string | null;
  [key: string]: unknown;
};

export type OfficeAllyApiResponse<T> = {
  data?: T | null;
};

export type OfficeAllyClaimStatusRequest = {
  payerId?: string | null;
  requestingProvider?: OfficeAllyProvider | null;
  serviceProvider?: OfficeAllyProvider | null;
  subscriber?: OfficeAllyPerson | null;
  dependent?: OfficeAllyPerson | null;
  claim?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type OfficeAllyClaimStatusContent = {
  statusCategory?: OfficeAllyCode | null;
  statusCode?: OfficeAllyCode | null;
  entityCode?: OfficeAllyCode | null;
  statusEffectiveDate?: string | null;
  totalChargeAmount?: string | number | null;
  paidAmount?: string | number | null;
  message?: string | null;
  [key: string]: unknown;
};

export type OfficeAllyClaimStatusServiceLine = {
  procedure?: unknown;
  statusInformation?: OfficeAllyClaimStatusContent[] | OfficeAllyClaimStatusContent | null;
  lineStatusInformation?: OfficeAllyClaimStatusContent[] | OfficeAllyClaimStatusContent | null;
  [key: string]: unknown;
};

export type OfficeAllyClaimStatusResponse = {
  responseStatus?: OfficeAllyCode | null;
  transactionId?: string | null;
  userId?: number | null;
  oaPayer?: OfficeAllyPayer | null;
  transactionErrors?: OfficeAllyAAAError[] | null;
  responsePayer?: unknown;
  requestingProvider?: unknown;
  serviceProvider?: unknown;
  subscriber?: unknown;
  dependent?: unknown;
  statusInformation?: OfficeAllyClaimStatusContent[] | OfficeAllyClaimStatusContent | null;
  healthCare?: unknown;
  serviceLines?: OfficeAllyClaimStatusServiceLine[] | null;
  x12?: string | null;
  [key: string]: unknown;
};

export type OfficeAllyPayerSearchOptionLookupRequest = {
  payerIds?: string[] | null;
};

export type OfficeAllyPayerSearchOptionInfo = {
  payerId?: string | null;
  payerName?: string | null;
  searchOptions?: unknown[] | null;
  [key: string]: unknown;
};

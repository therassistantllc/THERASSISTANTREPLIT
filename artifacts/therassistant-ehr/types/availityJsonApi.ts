// File: types/availityJsonApi.ts

type AvailityCode = {
  codeValue?: string | null;
  description?: string | null;
};

type AvailityAAAError = {
  loopId?: string | null;
  loopName?: string | null;
  validRequestIndicator?: string | null;
  rejectReason?: AvailityCode | null;
  followUpAction?: AvailityCode | null;
};

type AvailityPayer = {
  name?: string | null;
  payerId?: string | null;
};

type AvailityAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  countryCode?: string | null;
};

type AvailityProvider = {
  npi?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  providerID?: string | null;
  medicaidPin?: string | null;
  providerCode?: string | null;
  taxonomyCode?: string | null;
  suffix?: string | null;
  address?: AvailityAddress | null;
};

type AvailityPerson = {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  suffix?: string | null;
  dob?: string | null;
  dateOfBirth?: string | null;
  gender?: string | AvailityCode | null;
  memberId?: string | null;
  address?: AvailityAddress | null;
};

export type AvailityEligibilityRequest = {
  payerId?: string | null;
  provider?: AvailityProvider | null;
  requestingProvider?: AvailityProvider | null;
  subscriber?: AvailityPerson | null;
  dependent?: AvailityPerson | null;
  serviceTypeCodes?: string[] | null;
  procedureCodes?: unknown[] | null;
  [key: string]: unknown;
};

export type AvailityBenefitContent = {
  benefitInformationCode?: AvailityCode | null;
  coverageLevel?: AvailityCode | null;
  serviceTypeCodes?: AvailityCode[] | null;
  insuranceTypeCode?: AvailityCode | null;
  planCoverageDescription?: string | null;
  timePeriod?: AvailityCode | null;
  monetaryAmount?: string | number | null;
  percent?: string | number | null;
  quantityType?: AvailityCode | null;
  quantity?: string | number | null;
  requiresAuthorization?: AvailityCode | null;
  networkIndicator?: AvailityCode | null;
  messages?: string[] | null;
  benefitDates?: unknown;
  benefitDatesList?: unknown[] | null;
  placesOfService?: AvailityCode[] | null;
  relatedEntities?: unknown[] | null;
  [key: string]: unknown;
};

export type AvailityBenefitResponse = {
  plans?: AvailityBenefitContent[] | null;
  benefits?: AvailityBenefitContent[] | null;
  benefitDescriptions?: AvailityBenefitContent[] | null;
  exclusions?: AvailityBenefitContent[] | null;
  limitations?: AvailityBenefitContent[] | null;
  entities?: AvailityBenefitContent[] | null;
  preExistingConditions?: AvailityBenefitContent[] | null;
  disclaimers?: AvailityBenefitContent[] | null;
  otherPayers?: AvailityBenefitContent[] | null;
  miscellaneous?: AvailityBenefitContent[] | null;
  cannotProcess?: AvailityBenefitContent[] | null;
  otherSourceOfData?: AvailityBenefitContent[] | null;
};

type AvailityResponsePerson = AvailityPerson & {
  memberId?: string | null;
  planName?: string | null;
  groupNumber?: string | null;
  groupName?: string | null;
  ebResponseDetails?: AvailityBenefitResponse | null;
  [key: string]: unknown;
};

export type AvailityEligibilityResponse = {
  responseStatus?: AvailityCode | null;
  transactionId?: string | null;
  userId?: number | null;
  oaPayer?: AvailityPayer | null;
  transactionErrors?: AvailityAAAError[] | null;
  responsePayer?: AvailityPayer | null;
  requestingProvider?: unknown;
  subscriber?: AvailityResponsePerson | null;
  dependent?: AvailityResponsePerson | null;
  x12?: string | null;
  [key: string]: unknown;
};

export type AvailityApiResponse<T> = {
  data?: T | null;
};

export type AvailityClaimStatusRequest = {
  payerId?: string | null;
  requestingProvider?: AvailityProvider | null;
  serviceProvider?: AvailityProvider | null;
  subscriber?: AvailityPerson | null;
  dependent?: AvailityPerson | null;
  claim?: Record<string, unknown> | null;
  [key: string]: unknown;
};

type AvailityClaimStatusContent = {
  statusCategory?: AvailityCode | null;
  statusCode?: AvailityCode | null;
  entityCode?: AvailityCode | null;
  statusEffectiveDate?: string | null;
  totalChargeAmount?: string | number | null;
  paidAmount?: string | number | null;
  message?: string | null;
  [key: string]: unknown;
};

type AvailityClaimStatusServiceLine = {
  procedure?: unknown;
  statusInformation?: AvailityClaimStatusContent[] | AvailityClaimStatusContent | null;
  lineStatusInformation?: AvailityClaimStatusContent[] | AvailityClaimStatusContent | null;
  [key: string]: unknown;
};

export type AvailityClaimStatusResponse = {
  responseStatus?: AvailityCode | null;
  transactionId?: string | null;
  userId?: number | null;
  oaPayer?: AvailityPayer | null;
  transactionErrors?: AvailityAAAError[] | null;
  responsePayer?: unknown;
  requestingProvider?: unknown;
  serviceProvider?: unknown;
  subscriber?: unknown;
  dependent?: unknown;
  statusInformation?: AvailityClaimStatusContent[] | AvailityClaimStatusContent | null;
  healthCare?: unknown;
  serviceLines?: AvailityClaimStatusServiceLine[] | null;
  x12?: string | null;
  [key: string]: unknown;
};

export type AvailityPayerSearchOptionLookupRequest = {
  payerIds?: string[] | null;
};

export type AvailityPayerSearchOptionInfo = {
  payerId?: string | null;
  payerName?: string | null;
  searchOptions?: unknown[] | null;
  [key: string]: unknown;
};

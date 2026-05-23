export const DEFAULT_ORG_ID = "11111111-1111-1111-1111-111111111111";

export const ORGANIZATION_ID: string =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_ORGANIZATION_ID) ||
  DEFAULT_ORG_ID;

function getOrgIdFromSearchParams(searchParams: URLSearchParams): string {
  return searchParams.get("organizationId") || ORGANIZATION_ID;
}

function getOrgIdFromRequest(req: { nextUrl?: { searchParams: URLSearchParams }; url?: string }): string {
  if (req.nextUrl?.searchParams) {
    return req.nextUrl.searchParams.get("organizationId") || ORGANIZATION_ID;
  }
  if (req.url) {
    return new URL(req.url).searchParams.get("organizationId") || ORGANIZATION_ID;
  }
  return ORGANIZATION_ID;
}

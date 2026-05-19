// File: lib/clearinghouse/ediBuilders.ts
import type { ClaimStatusRequestInput, EligibilityRequestInput } from "@/types/clearinghouse";

export function buildMock270Request(input: EligibilityRequestInput, controlNumber: string, correlationId: string): string {
  return [
    "ISA*00*          *00*          *ZZ*THERASSISTANT*ZZ*MOCKCLEARING*240101*1200*^*00501*000000001*0*T*:~",
    `GS*HS*THERASSISTANT*MOCKCLEARING*20240101*1200*${controlNumber}*X*005010X279A1~`,
    `ST*270*${controlNumber}*005010X279A1~`,
    `BHT*0022*13*${correlationId}*20240101*1200~`,
    `NM1*IL*1*${(input.patientName ?? "PATIENT").replace(/\s+/g, "*")}****MI*${input.memberId ?? "UNKNOWN"}~`,
    `REF*1L*${input.payerId ?? "UNKNOWN"}~`,
    `EQ*${input.serviceTypeCode ?? "98"}~`,
    `SE*7*${controlNumber}~`,
    `GE*1*${controlNumber}~`,
    "IEA*1*000000001~",
  ].join("\n");
}

export function buildMock276Request(input: ClaimStatusRequestInput, controlNumber: string, correlationId: string): string {
  return [
    "ISA*00*          *00*          *ZZ*THERASSISTANT*ZZ*MOCKCLEARING*240101*1200*^*00501*000000002*0*T*:~",
    `GS*HR*THERASSISTANT*MOCKCLEARING*20240101*1200*${controlNumber}*X*005010X212~`,
    `ST*276*${controlNumber}*005010X212~`,
    `BHT*0010*13*${correlationId}*20240101*1200~`,
    `TRN*1*${input.claimId}*THERASSISTANT~`,
    `REF*1K*${input.payerId ?? "UNKNOWN"}~`,
    `AMT*T3*${input.claimAmount ?? 0}~`,
    `SE*7*${controlNumber}~`,
    `GE*1*${controlNumber}~`,
    "IEA*1*000000002~",
  ].join("\n");
}

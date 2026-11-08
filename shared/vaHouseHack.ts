/** Manual hypothetical financing scenario only; not eligibility or a property recommendation. */
export interface VaHouseHackRequest {
 contractVersion:'va-househack-v1'; occupation:'owner-occupied'; unitCount:number; ownerUnit:number;
 monthlyRents:(number|null)[]; price:number; availableCash:number; downPercent:number; annualRate:number; termYears:number;
 closingCostsCash:number; reservesCash:number;
 fundingFee:{exemption:'unknown'|'assume-exempt'|'assume-not-exempt';use:'first'|'subsequent'|'unknown';payment:'cash'|'financed'};
 costs:{annualTax:number|null;annualInsurance:number|null;maintenanceMonthlyCash:number|null;vacancyPercent:number;managementPercent:number};
 appreciation:{lowAnnualPercent:number;baseAnnualPercent:number;highAnnualPercent:number;years:number;sellingCostPercent:number};
}
export interface VaHouseHackResponse {
 contractVersion:'va-househack-v1';mode:'manual-scenario-only';officialEligibility:'not-verified';officialExemption:'not-verified';
 title:string;status:'scenario-complete'|'incomplete';missing:string[];assumptions:VaHouseHackRequest;
 finance:{downPayment:number;baseLoan:number;fundingFeePercent:number|null;fundingFee:number|null;loanAmount:number|null;monthlyPrincipalInterest:number|null;cashToClose:number|null;remainingCash:number|null;isCashShortage:boolean|null;cashShortageAmount:number|null};
 household:{ownerUnitScheduledRentExcluded:number|null;tenantScheduledMonthlyRent:number|null;effectiveTenantMonthlyRent:number|null;managementMonthly:number|null;monthlyOwnerHousingCostAfterTenantRent:number|null;annualActualCashSurplus:number|null;cashSurplusOnUpfrontCashPercent:number|null;ownerImputedRentIncluded:false;cashSurplusRatioStatus:'defined'|'zero-upfront-undefined'|'incomplete'};
 appreciation:{scenario:'low'|'base'|'high';annualPercent:number;years:number;hypotheticalSaleValue:number;sellingCosts:number;remainingLoanBalance:number|null;netSaleEquityBeforeTax:number|null}[];
 limitations:string[];
}

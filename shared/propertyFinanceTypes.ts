import type { ResearchPropertyType as PropertyType } from './research';

export interface FinancingAssumptions {
  interestRate: number;        // e.g. 6.5% or 6.75%
  loanTermYears: number;       // e.g. 30
  downPaymentPercent: number;  // e.g. 20%
  propertyTaxRate: number;     // e.g. 1.25%
  insuranceRate: number;       // e.g. 0.6%
  maintenanceRate: number;     // e.g. 5%
  vacancyRate: number;         // e.g. 5%
  managementRate: number;      // e.g. 8%
  holdingPeriodYears: number;  // e.g. 5
  closingCostPercent: number;  // e.g. 3% (defaults to 3%)
  initialReserves: number;     // e.g. $0 (defaults to 0)
  annualInsuranceAmount?: number; // e.g. $1,600/yr
}

export type TaxStatus = 'unknown' | 'manual' | 'assumed' | 'verified';

export interface PropertyTaxInput {
  status: TaxStatus;
  annualAmount: number | null; // null if unknown, 0 if user entered $0, or positive annual $
  source?: string | null;       // source or status note
  updatedAt?: string | null;    // local timestamp
}

export interface PropertyUnderwritingParams {
  purchasePrice: number;
  availableCash: number;
  financing: FinancingAssumptions;
  rentMonthly: number | null;
  rentStatus: 'assumed' | 'verified' | 'unknown' | 'manual';
  rentSource?: string;
  tax: PropertyTaxInput;
  annualInsurance?: number;
}

export interface PropertyUnderwritingResult {
  // Financing & Upfront Cash
  purchasePrice: number;
  availableCash: number;
  downPaymentPercent: number;
  downPaymentCash: number;
  loanAmount: number;
  closingCostPercent: number;
  closingCostCash: number;
  initialReserves: number;
  cashToClose: number;
  remainingCash: number;
  isCashShortage: boolean;
  cashShortageAmount: number;
  
  // Debt Service
  monthlyRate: number;
  numPayments: number;
  monthlyMortgagePayment: number;
  annualDebtService: number;

  // Rental Income
  rentStatus: 'assumed' | 'verified' | 'unknown' | 'manual';
  rentMonthly: number | null;
  annualGrossRent: number | null;

  // Operating Expenses
  taxStatus: TaxStatus;
  annualTax: number | null;
  monthlyTax: number | null;
  annualInsurance: number;
  monthlyInsurance: number;
  monthlyVacancy: number | null;
  annualVacancy: number | null;
  monthlyRepairs: number | null;
  annualRepairs: number | null;
  monthlyManagement: number | null;
  annualManagement: number | null;
  totalMonthlyOperatingExpenses: number | null;
  totalAnnualOperatingExpenses: number | null;

  // Returns
  isTaxKnown: boolean;
  isRentKnown: boolean;
  areReturnsComplete: boolean;
  returnsIncompleteReason?: string;
  
  effectiveGrossIncome: number | null;
  netOperatingIncome: number | null;
  annualCashFlow: number | null;
  monthlyCashFlow: number | null;
  capRatePercent: number | null;
  cashOnCashPercent: number | null;
}

export interface DemoPropertyFixture {
  id: string;
  isDemoFixture: true;
  label: string; // EXACTLY "Sample property — demo data, not a listing"
  variantNote?: string;
  purchasePrice: number;
  propertyType: PropertyType;
  units: number;
  rentAssumedMonthly: number;
  rentStatus: 'assumed';
  rentSource: string;
  insuranceAnnual: number;
  tax: PropertyTaxInput;
  hasExternalSource: false;
  sourceCitation: string;
  externalSourceTimestamp: null;
  localAddedAt: string;
}


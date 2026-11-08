import type { FinancingAssumptions } from './propertyFinanceTypes';

export const DEFAULT_FINANCING_ASSUMPTIONS: FinancingAssumptions = {
  interestRate: 6.5,
  loanTermYears: 30,
  downPaymentPercent: 20,
  propertyTaxRate: 1.25,
  insuranceRate: 0.6,
  maintenanceRate: 5,
  vacancyRate: 5,
  managementRate: 8,
  holdingPeriodYears: 5,
  closingCostPercent: 3,
  initialReserves: 0,
};

export function sanitizeFinancingAssumptions(raw: any): FinancingAssumptions {
  const safeNum = (val: any, fallback: number, min = 0, max = 1000): number => {
    if (typeof val === 'number' && !isNaN(val) && isFinite(val) && val >= min && val <= max) {
      return val;
    }
    const text = typeof val === 'string' ? val.trim() : '';
    const parsed = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
    if (!isNaN(parsed) && isFinite(parsed) && parsed >= min && parsed <= max) {
      return parsed;
    }
    return fallback;
  };

  return {
    // 0% interest is supported; negative interest is rejected and falls back safely to default
    interestRate: safeNum(raw?.interestRate, DEFAULT_FINANCING_ASSUMPTIONS.interestRate, 0, 30),
    loanTermYears: Math.round(safeNum(raw?.loanTermYears, DEFAULT_FINANCING_ASSUMPTIONS.loanTermYears, 1, 50)),
    downPaymentPercent: safeNum(raw?.downPaymentPercent, DEFAULT_FINANCING_ASSUMPTIONS.downPaymentPercent, 0, 100),
    propertyTaxRate: safeNum(raw?.propertyTaxRate, DEFAULT_FINANCING_ASSUMPTIONS.propertyTaxRate, 0, 15),
    insuranceRate: safeNum(raw?.insuranceRate, DEFAULT_FINANCING_ASSUMPTIONS.insuranceRate, 0, 10),
    maintenanceRate: safeNum(raw?.maintenanceRate, DEFAULT_FINANCING_ASSUMPTIONS.maintenanceRate, 0, 50),
    vacancyRate: safeNum(raw?.vacancyRate, DEFAULT_FINANCING_ASSUMPTIONS.vacancyRate, 0, 50),
    managementRate: safeNum(raw?.managementRate, DEFAULT_FINANCING_ASSUMPTIONS.managementRate, 0, 50),
    holdingPeriodYears: Math.round(safeNum(raw?.holdingPeriodYears, DEFAULT_FINANCING_ASSUMPTIONS.holdingPeriodYears, 1, 50)),
    closingCostPercent: safeNum(raw?.closingCostPercent, DEFAULT_FINANCING_ASSUMPTIONS.closingCostPercent, 0, 25),
    initialReserves: safeNum(raw?.initialReserves, DEFAULT_FINANCING_ASSUMPTIONS.initialReserves, 0, 10000000),
    annualInsuranceAmount: raw?.annualInsuranceAmount !== undefined ? safeNum(raw.annualInsuranceAmount, 1600, 0, 1000000) : undefined,
  };
}

/**
 * Property-Level Underwriting Engine:
 * - Purchase price is independent from available cash.
 * - Down payment = price * (downPaymentPercent / 100), never substitutes all available cash.
 * - Supports 0% interest if amortization math supports it; rejects negative interest.
 * - Keeps mortgage, down payment, cash-to-close, remaining cash available even when rent/tax is unknown.
 * - Distinguishes Unknown tax from manually entered $0 from entered annual amount.
 * - Marks tax-dependent returns incomplete if tax is unknown.
 */
export function calculatePropertyUnderwriting(
  params: import('./propertyFinanceTypes').PropertyUnderwritingParams
): import('./propertyFinanceTypes').PropertyUnderwritingResult & { isAvailableCashValid: boolean } {
  const { purchasePrice, availableCash, financing, rentMonthly, rentStatus, tax, annualInsurance: explicitInsurance } = params;

  // 1. Upfront Capital Requirements
  const downPaymentPercent = financing.downPaymentPercent;
  const downPaymentCash = purchasePrice * (downPaymentPercent / 100);
  const closingCostPercent = financing.closingCostPercent ?? 3;
  const closingCostCash = purchasePrice * (closingCostPercent / 100);
  const initialReserves = financing.initialReserves ?? 0;
  const cashToClose = downPaymentCash + closingCostCash + initialReserves;
  const isAvailableCashValid = Number.isFinite(availableCash) && availableCash >= 0;
  const remainingCash = isAvailableCashValid ? availableCash - cashToClose : NaN;
  const isCashShortage = !isAvailableCashValid || remainingCash < 0;
  const cashShortageAmount = isCashShortage ? Math.abs(remainingCash) : 0;

  // 2. Debt Service (Handles 0% interest, rejects negative interest)
  const loanAmount = Math.max(0, purchasePrice - downPaymentCash);
  const numPayments = financing.loanTermYears * 12;
  const interestRate = financing.interestRate;
  
  if (interestRate < 0) {
    throw new Error('Negative interest rate is not supported');
  }

  const monthlyRate = (interestRate / 100) / 12;
  let monthlyMortgagePayment = 0;
  if (loanAmount > 0 && numPayments > 0) {
    if (interestRate === 0) {
      monthlyMortgagePayment = loanAmount / numPayments;
    } else {
      const growthFactor = Math.pow(1 + monthlyRate, numPayments);
      monthlyMortgagePayment = loanAmount * (monthlyRate * growthFactor) / (growthFactor - 1);
    }
  }
  const annualDebtService = monthlyMortgagePayment * 12;

  // 3. Rental Income
  const isRentKnown = rentMonthly !== null && rentMonthly !== undefined && rentStatus !== 'unknown';
  const annualGrossRent = isRentKnown ? rentMonthly * 12 : null;

  // 4. Operating Expenses
  const annualInsurance = explicitInsurance !== undefined
    ? explicitInsurance
    : financing.annualInsuranceAmount !== undefined
    ? financing.annualInsuranceAmount
    : purchasePrice * (financing.insuranceRate / 100);
  const monthlyInsurance = annualInsurance / 12;

  const monthlyVacancy = isRentKnown ? (rentMonthly! * (financing.vacancyRate / 100)) : null;
  const annualVacancy = isRentKnown ? (annualGrossRent! * (financing.vacancyRate / 100)) : null;

  const monthlyRepairs = isRentKnown ? (rentMonthly! * (financing.maintenanceRate / 100)) : null;
  const annualRepairs = isRentKnown ? (annualGrossRent! * (financing.maintenanceRate / 100)) : null;

  const monthlyManagement = isRentKnown ? (rentMonthly! * (financing.managementRate / 100)) : null;
  const annualManagement = isRentKnown ? (annualGrossRent! * (financing.managementRate / 100)) : null;

  // Tax handling: distinguish Unknown from manually entered $0 from entered annual amount
  const taxStatus = tax.status;
  const isTaxKnown = (taxStatus === 'manual' || taxStatus === 'assumed' || taxStatus === 'verified') &&
    typeof tax.annualAmount === 'number' && Number.isFinite(tax.annualAmount) && tax.annualAmount >= 0;
  const annualTax = isTaxKnown ? (tax.annualAmount ?? 0) : null;
  const monthlyTax = isTaxKnown ? (annualTax! / 12) : null;

  let totalMonthlyOperatingExpenses: number | null = null;
  let totalAnnualOperatingExpenses: number | null = null;
  if (isRentKnown && isTaxKnown) {
    totalAnnualOperatingExpenses = annualVacancy! + annualRepairs! + annualManagement! + annualInsurance + annualTax!;
    totalMonthlyOperatingExpenses = totalAnnualOperatingExpenses / 12;
  }

  // 5. Returns Completeness & Performance Metrics
  const areReturnsComplete = isTaxKnown && isRentKnown;
  let returnsIncompleteReason: string | undefined;
  if (!isTaxKnown) {
    returnsIncompleteReason = 'Property tax is unknown. Net Operating Income (NOI), Cash Flow, Cap Rate, and Cash-on-Cash Return cannot be computed without verified tax records.';
  } else if (!isRentKnown) {
    returnsIncompleteReason = 'Rental income is unverified or unknown.';
  }

  let effectiveGrossIncome: number | null = null;
  let netOperatingIncome: number | null = null;
  let annualCashFlow: number | null = null;
  let monthlyCashFlow: number | null = null;
  let capRatePercent: number | null = null;
  let cashOnCashPercent: number | null = null;

  if (areReturnsComplete && annualGrossRent !== null && annualTax !== null) {
    effectiveGrossIncome = annualGrossRent - annualVacancy!;
    const nonVacancyOpEx = annualRepairs! + annualManagement! + annualInsurance + annualTax;
    netOperatingIncome = effectiveGrossIncome - nonVacancyOpEx;
    annualCashFlow = netOperatingIncome - annualDebtService;
    monthlyCashFlow = annualCashFlow / 12;
    capRatePercent = purchasePrice > 0 ? (netOperatingIncome / purchasePrice) * 100 : 0;
    cashOnCashPercent = cashToClose > 0 ? (annualCashFlow / cashToClose) * 100 : 0;
  }

  return {
    purchasePrice,
    availableCash,
    isAvailableCashValid,
    downPaymentPercent,
    downPaymentCash,
    loanAmount,
    closingCostPercent,
    closingCostCash,
    initialReserves,
    cashToClose,
    remainingCash,
    isCashShortage,
    cashShortageAmount,
    monthlyRate,
    numPayments,
    monthlyMortgagePayment,
    annualDebtService,
    rentStatus,
    rentMonthly,
    annualGrossRent,
    taxStatus,
    annualTax,
    monthlyTax,
    annualInsurance,
    monthlyInsurance,
    monthlyVacancy,
    annualVacancy,
    monthlyRepairs,
    annualRepairs,
    monthlyManagement,
    annualManagement,
    totalMonthlyOperatingExpenses,
    totalAnnualOperatingExpenses,
    isTaxKnown,
    isRentKnown,
    areReturnsComplete,
    returnsIncompleteReason,
    effectiveGrossIncome,
    netOperatingIncome,
    annualCashFlow,
    monthlyCashFlow,
    capRatePercent,
    cashOnCashPercent,
  };
}

/**
 * Factory for explicitly opt-in synthetic demo fixtures.
 * Labeled exactly: "Sample property — demo data, not a listing"
 * Has NO real/fake street address, NO listing URL, and NO implied recommendation.
 */
export function createDemoFixtures(): import('./propertyFinanceTypes').DemoPropertyFixture[] {
  const localAddedAt = new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const fixture1: import('./propertyFinanceTypes').DemoPropertyFixture = {
    id: 'demo-fixture-1',
    isDemoFixture: true,
    label: 'Sample property — demo data, not a listing',
    purchasePrice: 349000,
    propertyType: 'duplex',
    units: 2,
    rentAssumedMonthly: 2760,
    rentStatus: 'assumed',
    rentSource: 'Assumed rental benchmark (demo parameter)',
    insuranceAnnual: 1600,
    tax: {
      status: 'unknown',
      annualAmount: null,
      source: 'County auditor tax record unrecorded / pending assessment',
      updatedAt: localAddedAt,
    },
    hasExternalSource: false,
    sourceCitation: 'No external source — synthetic demo data',
    externalSourceTimestamp: null,
    localAddedAt,
  };

  // Second fixture copies first fixture's assumptions/data and changes only price to $300,000
  const fixture2: import('./propertyFinanceTypes').DemoPropertyFixture = {
    ...fixture1,
    id: 'demo-fixture-2',
    purchasePrice: 300000,
    variantNote: '$300,000 comparison variant',
    label: 'Sample property — demo data, not a listing',
  };

  return [fixture1, fixture2];
}

export function parseManualTaxAmount(raw: string): import('./propertyFinanceTypes').PropertyTaxInput {
  const text = raw.trim();
  const amount = Number(text);
  if (!text || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(amount) || amount < 0) {
    return { status: 'unknown', annualAmount: null, source: 'Tax amount blank or invalid — no tax assumption applied' };
  }
  return { status: 'manual', annualAmount: amount, source: amount === 0 ? 'User-entered $0 assumption' : `User-entered annual tax assumption ($${amount.toLocaleString()}/yr)` };
}

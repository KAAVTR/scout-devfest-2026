/**
 * Type-only wire criteria for this phone snapshot.
 * The assessment parser already accepts these fields at runtime.
 * This module exports no values and is not loaded by the phone server.
 */
export interface SearchCriteria {
  scope: string;
  locationName?: string;
  selectedState?: string;
  selectedMetro?: string;
  selectedZip?: string;
  manualListings?: string[];
  maxPurchasePrice: number;
  downPaymentCash: number;
  propertyTypes: string[];
  strategy: string;
  naturalLanguageQuery?: string;
}

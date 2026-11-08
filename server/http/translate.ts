/** Deterministic plain-English criteria parser. Makes no provider calls, so it cannot burn model quota. */
// Fallback semantic parser for plain-English query interpretation
export function parseQueryFallback(query: string) {
  const text = query.toLowerCase();
  
  // Scope & location detection
  let scope = 'usa';
  let locationName = 'United States (National)';
  
  const states = [
    { name: 'North Carolina', code: 'NC' },
    { name: 'Florida', code: 'FL' },
    { name: 'Texas', code: 'TX' },
    { name: 'Ohio', code: 'OH' },
    { name: 'Georgia', code: 'GA' },
    { name: 'Tennessee', code: 'TN' },
    { name: 'Michigan', code: 'MI' },
    { name: 'Pennsylvania', code: 'PA' },
    { name: 'Indiana', code: 'IN' },
    { name: 'Arizona', code: 'AZ' },
  ];
  
  for (const st of states) {
    if (text.includes(st.name.toLowerCase()) || text.includes(` in ${st.code.toLowerCase()}`)) {
      scope = 'state';
      locationName = st.name;
      break;
    }
  }

  const metros = [
    'columbus', 'raleigh', 'tampa', 'charlotte', 'orlando', 'cleveland', 
    'indianapolis', 'atlanta', 'dallas', 'houston', 'san antonio', 'nashville'
  ];
  for (const m of metros) {
    if (text.includes(m)) {
      scope = 'metro';
      locationName = m.charAt(0).toUpperCase() + m.slice(1) + ' Metro';
      break;
    }
  }

  const zipMatch = text.match(/\b\d{5}\b/);
  if (zipMatch) {
    scope = 'zip';
    locationName = `ZIP ${zipMatch[0]}`;
  }

  // Budget detection
  let maxBudget: number | null = null;
  const budgetMatch = text.match(/under\s*\$?([\d,]+)k?/i) || text.match(/\$?([\d,]+)k?\s*(?:budget|max|limit)/i) || text.match(/\$?([\d,]+)(?:,\d{3})+/);
  if (budgetMatch) {
    let numStr = budgetMatch[1].replace(/,/g, '');
    let val = parseFloat(numStr);
    if (budgetMatch[0].toLowerCase().includes('k') && val < 10000) {
      val = val * 1000;
    } else if (val < 1000) {
      val = val * 1000;
    }
    if (val >= 20000 && val <= 50000000) {
      maxBudget = val;
    }
  }

  // Down payment cash detection
  let downPaymentCash: number | null = null;
  const downMatch = text.match(/(\$?\d[\d,]*k?)\s*(?:down|cash|capital|savings)/i);
  if (downMatch) {
    let numStr = downMatch[1].replace(/[$,]/g, '');
    let val = parseFloat(numStr);
    if (downMatch[1].toLowerCase().includes('k') && val < 10000) val *= 1000;
    if (val > 1000) downPaymentCash = val;
  }

  // Property types
  const propertyTypes: string[] = [];
  if (text.includes('duplex')) propertyTypes.push('duplex');
  if (text.includes('triplex')) propertyTypes.push('triplex');
  if (text.includes('fourplex') || text.includes('4-plex') || text.includes('4plex')) propertyTypes.push('fourplex');
  if (text.includes('multi-family') || text.includes('multifamily') || text.includes('small multi')) {
    if (!propertyTypes.includes('duplex')) propertyTypes.push('duplex');
    if (!propertyTypes.includes('triplex')) propertyTypes.push('triplex');
    if (!propertyTypes.includes('fourplex')) propertyTypes.push('fourplex');
  }
  if (text.includes('single family') || text.includes('sfr') || text.includes('single-family')) {
    propertyTypes.push('single-family');
  }
  if (text.includes('townhouse') || text.includes('townhome')) propertyTypes.push('townhome');
  if (text.includes('condo')) propertyTypes.push('condo');

  // No type mentioned: return none so the UI keeps the user's explicit selection (no silent default).

  // Strategy
  let strategy = 'long-term-rental';
  if (text.includes('short term') || /\bstr\b/.test(text) || text.includes('airbnb') || text.includes('vacation')) {
    strategy = 'short-term-rental';
  } else if (text.includes('flip') || text.includes('renovate') || text.includes('rehab') || text.includes('fix and flip')) {
    strategy = 'renovation-resale';
  } else if (text.includes('brrrr')) {
    strategy = 'brrrr';
  }

  // Ranking weights (0 - 100)
  const suggestedWeights = {
    demographics: text.includes('population') || text.includes('growth') || text.includes('migration') ? 85 : 70,
    infrastructure: text.includes('transit') || text.includes('grant') || text.includes('transportation') ? 85 : 60,
    retailAnchors: text.includes('starbucks') || text.includes('retail') || text.includes('commercial') ? 75 : 55,
    hazardRisk: text.includes('flood') || text.includes('hurricane') || text.includes('hazard') || text.includes('climate') ? 90 : 70,
    rentYield: text.includes('cash flow') || text.includes('yield') || text.includes('rent') ? 85 : 60,
    schoolQuality: text.includes('school') || text.includes('education') || text.includes('family') ? 80 : 50,
  };

  // Detect unverifiable requirements
  const unverifiableRequirements: string[] = [];
  if (text.includes('quiet') || text.includes('peaceful')) {
    unverifiableRequirements.push('Subjective street noise and quietness cannot be determined from public records.');
  }
  if (text.includes('friendly neighbor') || text.includes('community feel')) {
    unverifiableRequirements.push('Neighborhood social dynamics cannot be verified and are not scored.');
  }
  if (text.includes('off-market') || text.includes('wholesale')) {
    unverifiableRequirements.push('Private off-market seller discounts cannot be verified through official public listing feeds.');
  }
  if (text.includes('no hoa') || text.includes('lenient hoa')) {
    unverifiableRequirements.push('HOA covenant rules and rental restrictions require deed review and cannot be guaranteed automatically.');
  }

  return {
    scope,
    locationName,
    maxBudget,
    downPaymentCash,
    propertyTypes,
    strategy,
    suggestedWeights,
    unverifiableRequirements,
    explanation: `Interpreted "${query}" into target scope (${locationName}), strategy (${strategy.replace(/-/g, ' ')}), and calibrated ranking priorities. Deterministic keyword parser (no AI call). Review every field; budget, cash, type, strategy and geography are enforced as hard constraints.`,
  };
}


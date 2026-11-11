// Structured customer addresses (Nigeria). "physicalAddress" is the one-line form
// built from these parts, used on invoices, lists and in the audit trail.

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta',
  'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Federal Capital Territory', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau',
  'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

export const ADDRESS_FIELDS = ['addressLine1', 'addressLine2', 'area', 'city', 'state', 'postCode'];

const LIMITS = { addressLine1: 120, addressLine2: 120, area: 80, city: 80 };
const LABELS = { addressLine1: 'Address line 1', addressLine2: 'Address line 2', area: 'Area', city: 'City / town', state: 'State', postCode: 'Post code' };

/** Validates and trims one supplied address part. Returns { value } or { error }. */
export function validateAddressPart(key, value) {
  if (typeof value !== 'string') return { error: `${LABELS[key]} must be text.` };
  const text = value.trim().replace(/\s+/g, ' ');
  if (key === 'state') {
    const match = NIGERIAN_STATES.find(state => state.toLowerCase() === text.toLowerCase());
    return match ? { value: match } : { error: 'Select a valid state.' };
  }
  if (key === 'postCode') {
    return text === '' || /^\d{6}$/.test(text) ? { value: text } : { error: 'Post code must be 6 digits.' };
  }
  if (text.length > LIMITS[key]) return { error: `${LABELS[key]} must be ${LIMITS[key]} characters or fewer.` };
  return { value: text };
}

/** Error message if the combined address is missing a required part, otherwise null. */
export function missingAddressPart(address) {
  if (!address.addressLine1) return 'Address line 1 is required.';
  if (!address.city) return 'City / town is required.';
  if (!address.state) return 'State is required.';
  return null;
}

/** One-line address, e.g. "Plot 2B, OPIC Industrial Park, Agbara, Ogun State 112105". */
export function formatAddress(address) {
  const state = address.state
    ? `${address.state === 'Federal Capital Territory' ? address.state : `${address.state} State`}${address.postCode ? ` ${address.postCode}` : ''}`
    : address.postCode;
  return [address.addressLine1, address.addressLine2, address.area, address.city, state]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

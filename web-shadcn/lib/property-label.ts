/**
 * Label for a property in a picker.
 *
 * Most properties are named after their own street address, which made every
 * option read "10054 Copper Hollow Ln. — 10054 Copper Hollow Ln, Houston, TX
 * 77044-5594" — the same thing twice, and long enough that it had to be
 * truncated before it said anything useful. When the address already begins
 * with the name, the name adds nothing.
 */
export function propertyOptionLabel(name: string, address: string): string {
  if (!address) return name;
  if (!name) return address;
  // Punctuation and spacing differ between the two fields ("Ln." vs "Ln"), so
  // compare on letters and digits only.
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedName = normalize(name);
  if (!normalizedName) return address;
  return normalize(address).startsWith(normalizedName) ? address : `${name} — ${address}`;
}

export function formatUnitName(value?: string | null) {
  const name = value?.trim();
  if (!name) return undefined;
  return /^unit\b/i.test(name) ? name : `Unit ${name}`;
}

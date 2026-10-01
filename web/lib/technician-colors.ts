/**
 * A colour for each technician, so their trail, their planned route and their
 * marker can be told apart from everyone else's on the technician map (the
 * office, 2026-10-02: "the trailing lines and the lines that connects to the
 * scheduled property").
 *
 * None of the map's own colours: no green (benefit-package properties, and the
 * technician badge itself), no yellow (properties off the package), no orange
 * (the selected technician's route ahead), no grey (what is done). Dark enough
 * to read on the light roadmap; the lines are drawn over a white casing, which
 * carries them over the dark one.
 */
export const TECHNICIAN_COLORS = [
  '#2563eb', // blue
  '#9333ea', // purple
  '#db2777', // pink
  '#dc2626', // red
  '#0891b2', // cyan
  '#4338ca', // indigo
  '#c026d3', // fuchsia
  '#92400e', // brown
  '#1e3a8a', // navy
  '#9f1239', // maroon
] as const;

/** FNV-1a: small, and the same answer for the same id on every machine. */
function hashOf(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Who gets which colour, among the people on the map.
 *
 * From each person's id rather than their place in the list, so somebody keeps
 * their colour from one day to the next whoever else is out -- moved along only
 * when two people on the same day would otherwise share one. Decided in id
 * order, so every reader's console agrees. Past ten people on one day, colours
 * repeat.
 */
export function technicianColors(ids: Iterable<string>): Map<string, string> {
  const colors = new Map<string, string>();
  const taken = new Set<number>();
  for (const id of [...new Set(ids)].sort()) {
    if (taken.size === TECHNICIAN_COLORS.length) taken.clear();
    let index = hashOf(id) % TECHNICIAN_COLORS.length;
    while (taken.has(index)) index = (index + 1) % TECHNICIAN_COLORS.length;
    taken.add(index);
    colors.set(id, TECHNICIAN_COLORS[index]!);
  }
  return colors;
}

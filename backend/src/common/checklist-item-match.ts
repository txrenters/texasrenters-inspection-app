/**
 * Whether a finding is about a checklist item: one of the item's keywords, or a
 * word of its name, appears in the finding's title or category. Imported
 * move-ins file their photographs under checklist items ("Doors and locks",
 * keywords door and lock), and every room's checklist is worded the same way,
 * which is what makes this answerable at all.
 *
 * Shared by the AI's look at the video, which uses it to find the move-in
 * photograph of the same item, and the move-in comparison, which uses it to
 * show each finding beside the item it is about.
 */
export function findingMatchesChecklistItem(
  finding: { title: string; category: string },
  item: { label: string; keywords: string[] } | null,
) {
  if (!item) return false;
  const text = `${finding.title} ${finding.category}`.toLowerCase();
  const words = [
    ...item.keywords,
    ...item.label.split(/[^a-z]+/i).filter((word) => word.length > 3),
  ].map((word) => word.toLowerCase().replace(/s$/, ''));
  return words.some((word) => word.length > 2 && text.includes(word));
}

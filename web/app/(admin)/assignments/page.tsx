import { redirect } from 'next/navigation';

/**
 * The Assignments page was removed (console-development, 2026-10-10): every
 * day-to-day thing it did is on Inspections -- who is on each visit, filtering
 * by technician and type, assigning and reassigning one or many -- and each
 * inspection keeps its own assignment history on its page.
 *
 * Old links and bookmarks forward to the same view there, every date, rather
 * than to a 404: `technician` becomes the list's `tech`, the type stays, and
 * "Unassigned" becomes the list's unassigned filter.
 */
export default async function AssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const asked = await searchParams;
  const one = (key: string) => {
    const value = asked[key];
    return typeof value === 'string' ? value : undefined;
  };
  const query = new URLSearchParams({ day: 'all' });
  const type = one('type');
  if (type) query.set('type', type);
  const technician = one('technician');
  if (one('status') === 'UNASSIGNED') query.set('tech', 'unassigned');
  else if (technician) query.set('tech', technician);
  redirect(`/inspections?${query.toString()}`);
}

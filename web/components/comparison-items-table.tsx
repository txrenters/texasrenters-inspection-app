'use client';

import type { AdminComparisonFinding, AdminComparisonItem } from '@texasrenters/shared';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { changeMeta, gradeText, isWaiting } from '@/lib/comparison-items';
import { cn } from '@/lib/utils';

/** A finding the office confirmed, under the item it is about. */
function ConfirmedLine({ finding }: { finding: AdminComparisonFinding }) {
  return (
    <li className="text-muted-foreground text-xs">
      <span className="text-foreground">{finding.title}</span>
      {' · '}
      {finding.source === 'REVIEWER' ? 'added by a reviewer' : 'confirmed'}
    </li>
  );
}

/**
 * One room's checklist, move-in against move-out, item by item: what each
 * inspection recorded, what changed, and what the office confirmed about it.
 *
 * Only the findings the office has confirmed are listed (2026-10-09). The ones
 * still waiting were every line of this table once -- 51 in one kitchen, most
 * of them the checklist's own marks said again -- and nothing here can confirm
 * them; the room counts them and links to the inspection page instead.
 */
export function ComparisonItemsTable({
  items,
  otherFindings,
}: {
  items: AdminComparisonItem[];
  otherFindings: AdminComparisonFinding[];
}) {
  const confirmedElsewhere = otherFindings.filter((finding) => !isWaiting(finding));
  return (
    <div className="grid gap-2">
      {items.length ? (
        <Table aria-label="Checklist items, move-in against move-out">
          {/* A short table inside a card: no sticky header to pin. */}
          <TableHeader className="lg:static">
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Move-in</TableHead>
              <TableHead>Move-out</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const meta = changeMeta(item);
              const quiet =
                (item.change === 'NO_CHANGE' || item.change === 'NOT_GRADED') && !item.cleaning;
              const confirmed = item.findings.filter((finding) => !isWaiting(finding));
              return (
                <TableRow className={cn(quiet && 'text-muted-foreground')} key={item.itemId}>
                  <TableCell className="align-top font-medium whitespace-normal">
                    {item.label}
                    {confirmed.length ? (
                      <ul className="mt-1 grid gap-0.5 font-normal">
                        {confirmed.map((finding) => (
                          <ConfirmedLine finding={finding} key={finding.id} />
                        ))}
                      </ul>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {gradeText(item.moveIn)}
                    {item.moveIn?.comment ? (
                      <p className="text-muted-foreground text-xs italic">{item.moveIn.comment}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {gradeText(item.moveOut)}
                    {item.moveOut?.comment ? (
                      <p className="text-muted-foreground text-xs italic">{item.moveOut.comment}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap gap-1">
                      {quiet ? (
                        <span className="text-xs">{meta.label}</span>
                      ) : item.change !== 'NO_CHANGE' && item.change !== 'NOT_GRADED' ? (
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      ) : null}
                      {item.cleaning === 'NEEDS_CLEANING' ? (
                        <Badge variant="warning">Needs cleaning</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      {confirmedElsewhere.length ? (
        <div className="grid gap-1">
          <p className="text-muted-foreground text-xs font-medium">Also confirmed in this room</p>
          <ul className="grid gap-0.5">
            {confirmedElsewhere.map((finding) => (
              <ConfirmedLine finding={finding} key={finding.id} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

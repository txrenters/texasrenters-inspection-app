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
import { changeMeta, findingStatus, gradeText } from '@/lib/comparison-items';
import { cn } from '@/lib/utils';

function FindingLine({ finding }: { finding: AdminComparisonFinding }) {
  return (
    <li className="text-muted-foreground text-xs">
      <span className="text-foreground">{finding.title}</span>
      {' · '}
      {finding.source === 'AI_VISION'
        ? 'spotted by AI'
        : finding.source === 'REVIEWER'
          ? 'added by a reviewer'
          : 'AI finding'}
      {' · '}
      {findingStatus(finding.reviewStatus)}
    </li>
  );
}

/**
 * One room's checklist, move-in against move-out, item by item: what each
 * inspection recorded, what changed, and the move-out's findings about it.
 *
 * Items that did not change are kept, quieter: "the windows were fine at both"
 * is part of the answer, and a reviewer disputing a charge needs to see it.
 */
export function ComparisonItemsTable({
  items,
  otherFindings,
}: {
  items: AdminComparisonItem[];
  otherFindings: AdminComparisonFinding[];
}) {
  return (
    <div className="grid gap-2">
      <Table aria-label="Checklist items, move-in against move-out">
        {/* A short table inside a card: no sticky header to pin. */}
        <TableHeader className="lg:static">
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Move-in</TableHead>
            <TableHead>Move-out</TableHead>
            <TableHead>Change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const meta = changeMeta(item);
            const quiet =
              (item.change === 'NO_CHANGE' || item.change === 'NOT_GRADED') &&
              !item.cleaning &&
              !item.findings.length;
            return (
              <TableRow className={cn(quiet && 'text-muted-foreground')} key={item.itemId}>
                <TableCell className="align-top font-medium whitespace-normal">
                  {item.label}
                  {item.findings.length ? (
                    <ul className="mt-1 grid gap-0.5 font-normal">
                      {item.findings.map((finding) => (
                        <FindingLine finding={finding} key={finding.id} />
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
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                    {item.cleaning === 'NEEDS_CLEANING' ? (
                      <Badge variant="info">Needs cleaning</Badge>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {otherFindings.length ? (
        <div className="grid gap-1">
          <p className="text-muted-foreground text-xs font-medium">
            Findings about no checklist item
          </p>
          <ul className="grid gap-0.5">
            {otherFindings.map((finding) => (
              <FindingLine finding={finding} key={finding.id} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

'use client';

import type { AdminCharge, AdminChargeRule, AdminPetCandidate } from '@texasrenters/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/lib/auth';
import { EMPTY, humanize } from '@/lib/format';
import {
  useAdminMutations,
  useChargeRules,
  useInspectionCharges,
  useInspectionPets,
} from '@/lib/queries';

function money(amount: number | null | undefined, currency = 'USD') {
  if (amount === null || amount === undefined) return EMPTY;
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(2)}`;
}

/** A decided charge is history; a pending one is a decision waiting to be made. */
const CHARGE_STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning'> = {
  APPROVED: 'success',
  ADJUSTED: 'success',
  REJECTED: 'destructive',
  WAIVED: 'destructive',
};

const DECIDED = ['APPROVED', 'REJECTED', 'ADJUSTED', 'WAIVED'];

/**
 * Pet review + configurable charges (spec §13/§14). Technicians only record
 * evidence; a reviewer confirms unique/unauthorized pets and finalizes every
 * charge. Nothing here is ever auto-approved.
 */
export function InspectionChargesPanel({
  inspectionId,
  inspectionType,
}: {
  inspectionId: string;
  inspectionType: string;
}) {
  const permissions = usePermissions();
  const canReview = permissions.has('charges:review');
  const canConfigure = permissions.has('charges:configure');
  const isOccupied = inspectionType === 'OCCUPIED';

  const pets = useInspectionPets(inspectionId, canReview && isOccupied);
  const charges = useInspectionCharges(inspectionId, canReview);
  const rules = useChargeRules(canReview);
  const mutations = useAdminMutations();
  const [addingCharge, setAddingCharge] = useState(false);

  const petRule = rules.data?.find((rule) => rule.code === 'UNAUTHORIZED_PET') ?? null;

  if (!canReview)
    return (
      <Card className="scroll-mt-20" id="charges">
        <CardHeader>
          <CardTitle>Charges &amp; pet review</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            You do not have permission to review charges.
          </p>
        </CardContent>
      </Card>
    );

  return (
    <Card aria-labelledby="inspection-charges-title" className="scroll-mt-20" id="charges">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle id="inspection-charges-title">Charges &amp; pet review</CardTitle>
          <CardDescription>
            A reviewer confirms unique unauthorized pets and finalizes charges — nothing is
            auto-approved.
          </CardDescription>
        </div>
        <Button asChild variant="outline">
          <Link href={`/inspections/${inspectionId}/charge-report`}>View report</Link>
        </Button>
      </CardHeader>

      <CardContent className="space-y-6">
        <ChargeRuleBanner canConfigure={canConfigure} rule={petRule} />

        {isOccupied ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Pet review</h3>
              <Button
                disabled={mutations.generatePetCandidates.isPending}
                onClick={() => mutations.generatePetCandidates.mutate({ id: inspectionId })}
                size="sm"
                type="button"
                variant="outline"
              >
                {mutations.generatePetCandidates.isPending ? <Spinner /> : null}
                {mutations.generatePetCandidates.isPending ? 'Grouping…' : 'Group observations'}
              </Button>
            </div>
            {pets.isLoading ? (
              <PageSkeleton cards={1} />
            ) : pets.isError ? (
              <ErrorState error={pets.error} retry={() => void pets.refetch()} />
            ) : pets.data?.candidates.length ? (
              <ul className="grid gap-2">
                {pets.data.candidates.map((candidate) => (
                  <PetCandidateRow
                    candidate={candidate}
                    inspectionId={inspectionId}
                    key={candidate.id}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
                {pets.data?.observations.length
                  ? `${pets.data.observations.length} observation${pets.data.observations.length === 1 ? '' : 's'} recorded — group them into unique animals to review.`
                  : 'No pet observations were recorded for this inspection.'}
              </p>
            )}
          </section>
        ) : null}

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Charges</h3>
            <div className="flex flex-wrap gap-2">
              {isOccupied ? (
                <Button
                  disabled={mutations.generateCharges.isPending}
                  onClick={() => mutations.generateCharges.mutate({ id: inspectionId })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {mutations.generateCharges.isPending ? <Spinner /> : null}
                  {mutations.generateCharges.isPending ? 'Generating…' : 'Generate pet charges'}
                </Button>
              ) : null}
              <Button onClick={() => setAddingCharge(true)} size="sm" type="button">
                Add charge
              </Button>
            </div>
          </div>

          {mutations.generateCharges.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutations.generateCharges.error.message}</AlertDescription>
            </Alert>
          ) : null}

          {charges.isLoading ? (
            <PageSkeleton cards={1} />
          ) : charges.isError ? (
            <ErrorState error={charges.error} retry={() => void charges.refetch()} />
          ) : charges.data?.length ? (
            <ul className="grid gap-2">
              {charges.data.map((charge) => (
                <ChargeRow charge={charge} inspectionId={inspectionId} key={charge.id} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
              No charges have been proposed.
            </p>
          )}
        </section>
      </CardContent>

      {addingCharge ? (
        <AddChargeDialog inspectionId={inspectionId} onClose={() => setAddingCharge(false)} />
      ) : null}
    </Card>
  );
}

function ChargeRuleBanner({
  rule,
  canConfigure,
}: {
  rule: AdminChargeRule | null;
  canConfigure: boolean;
}) {
  const mutation = useAdminMutations().upsertChargeRule;
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(rule?.amount ?? 25));

  return (
    <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">Unauthorized pet charge</p>
        <p className="text-muted-foreground text-xs">
          {rule
            ? `${money(rule.amount, rule.currency)} per unique pet${rule.isActive ? '' : ' (inactive)'}`
            : 'Not configured'}
        </p>
      </div>
      {canConfigure ? (
        editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(
                { code: 'UNAUTHORIZED_PET', amount: Number(amount), isActive: true },
                { onSuccess: () => setEditing(false) },
              );
            }}
          >
            <Input
              aria-label="Charge amount"
              className="w-28"
              min="0"
              onChange={(event) => setAmount(event.target.value)}
              step="0.01"
              type="number"
              value={amount}
            />
            <Button disabled={mutation.isPending} size="sm" type="submit">
              Save
            </Button>
            <Button onClick={() => setEditing(false)} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
          </form>
        ) : (
          <Button onClick={() => setEditing(true)} size="sm" type="button" variant="outline">
            {rule ? 'Edit amount' : 'Configure'}
          </Button>
        )
      ) : null}
    </div>
  );
}

const REVIEW_STATUSES = ['PENDING_REVIEW', 'UNIQUE_PET', 'DUPLICATE', 'INSUFFICIENT_EVIDENCE'];
const AUTH_STATUSES = ['UNKNOWN', 'AUTHORIZED', 'UNAUTHORIZED'];

function PetCandidateRow({
  inspectionId,
  candidate,
}: {
  inspectionId: string;
  candidate: AdminPetCandidate;
}) {
  const mutation = useAdminMutations().reviewPetCandidate;
  const [reviewStatus, setReviewStatus] = useState(candidate.reviewStatus);
  const [authorizationStatus, setAuthorizationStatus] = useState(candidate.authorizationStatus);

  const dirty =
    reviewStatus !== candidate.reviewStatus ||
    authorizationStatus !== candidate.authorizationStatus;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{candidate.label}</p>
        <p className="text-muted-foreground text-xs">
          {candidate.species} · {candidate.observationCount} observation
          {candidate.observationCount === 1 ? '' : 's'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          onValueChange={(next) => setReviewStatus(next as AdminPetCandidate['reviewStatus'])}
          value={reviewStatus}
        >
          <SelectTrigger aria-label="Review status" className="w-[180px]" id={`rs-${candidate.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {humanize(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(next) =>
            setAuthorizationStatus(next as AdminPetCandidate['authorizationStatus'])
          }
          value={authorizationStatus}
        >
          <SelectTrigger aria-label="Authorization" className="w-[150px]" id={`as-${candidate.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {humanize(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={!dirty || mutation.isPending}
          onClick={() =>
            mutation.mutate({
              inspectionId,
              candidateId: candidate.id,
              reviewStatus,
              authorizationStatus,
            })
          }
          size="sm"
          type="button"
        >
          {mutation.isPending ? <Spinner /> : null}
          Save
        </Button>
      </div>
    </li>
  );
}

function ChargeRow({ inspectionId, charge }: { inspectionId: string; charge: AdminCharge }) {
  const mutation = useAdminMutations().reviewCharge;
  const [adjusting, setAdjusting] = useState(false);
  const [amount, setAmount] = useState(String(charge.proposedAmount));
  const decided = DECIDED.includes(charge.status);

  return (
    <li className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{charge.description}</p>
          <p className="text-muted-foreground text-xs">
            {charge.chargeCode} · proposed {money(charge.proposedAmount, charge.currency)}
            {charge.approvedAmount !== null && charge.approvedAmount !== undefined
              ? ` · approved ${money(charge.approvedAmount, charge.currency)}`
              : ''}
            {' · '}
            <span title="Origin of this charge">{humanize(charge.source).toLowerCase()}</span>
          </p>
        </div>
        <Badge variant={CHARGE_STATUS_VARIANT[charge.status] ?? 'warning'}>
          {humanize(charge.status)}
        </Badge>
      </div>

      {!decided ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ inspectionId, chargeId: charge.id, decision: 'APPROVE' })
            }
            size="sm"
            type="button"
          >
            Approve
          </Button>
          <Button
            onClick={() => setAdjusting((value) => !value)}
            size="sm"
            type="button"
            variant="outline"
          >
            Adjust
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ inspectionId, chargeId: charge.id, decision: 'WAIVE' })}
            size="sm"
            type="button"
            variant="outline"
          >
            Waive
          </Button>
          <Button
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ inspectionId, chargeId: charge.id, decision: 'REJECT' })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            Reject
          </Button>
        </div>
      ) : null}

      {adjusting ? (
        <form
          className="flex flex-wrap items-end gap-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(
              {
                inspectionId,
                chargeId: charge.id,
                decision: 'ADJUST',
                approvedAmount: Number(amount),
              },
              { onSuccess: () => setAdjusting(false) },
            );
          }}
        >
          <Field className="w-32">
            <FieldLabel htmlFor={`adjust-${charge.id}`}>Adjusted amount</FieldLabel>
            <Input
              id={`adjust-${charge.id}`}
              min="0"
              onChange={(event) => setAmount(event.target.value)}
              step="0.01"
              type="number"
              value={amount}
            />
          </Field>
          <Button disabled={mutation.isPending} size="sm" type="submit">
            {mutation.isPending ? <Spinner /> : null}
            Save adjusted
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function AddChargeDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().createCharge;
  const [description, setDescription] = useState('');
  const [unitAmount, setUnitAmount] = useState('');
  const [reason, setReason] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        id: inspectionId,
        description: description.trim(),
        unitAmount: Number(unitAmount),
        reason: reason.trim() || undefined,
      });
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Add a charge</DialogTitle>
            <DialogDescription>
              Manually proposed charges start as pending review — they are not approved until
              reviewed.
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="charge-description">Description</FieldLabel>
            <Input
              id="charge-description"
              onChange={(event) => setDescription(event.target.value)}
              required
              value={description}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="charge-amount">Amount</FieldLabel>
            <Input
              id="charge-amount"
              min="0"
              onChange={(event) => setUnitAmount(event.target.value)}
              required
              step="0.01"
              type="number"
              value={unitAmount}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="charge-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="charge-reason"
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              value={reason}
            />
          </Field>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={mutation.isPending || !description.trim() || !unitAmount}
              type="submit"
            >
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Adding…' : 'Add charge'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

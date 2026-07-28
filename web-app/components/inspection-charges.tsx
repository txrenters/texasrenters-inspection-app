'use client';

import type {
  AdminCharge,
  AdminChargeRule,
  AdminPetCandidate,
} from '@texasrenters/shared';
import Link from 'next/link';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldError } from '@/components/ui/field';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { ErrorState, LoadingState } from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import {
  useAdminMutations,
  useChargeRules,
  useInspectionCharges,
  useInspectionPets,
} from '@/lib/queries';

function money(amount: number | null | undefined, currency = 'USD') {
  if (amount === null || amount === undefined) return '—';
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(2)}`;
}

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
      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section>
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Charges</span>
            <CardTitle className="text-[17px]">Charges &amp; pet review</CardTitle>
          </div>
        </CardHeader>
        <p className="text-[13px] text-muted-foreground">You do not have permission to review charges.</p>
      </section>
      </Card>
    );

  return (
      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section aria-labelledby="inspection-charges-title">
        <CardHeader className="p-0 pb-4">
        <div>
          <span className="block text-xs font-semibold text-muted-foreground">Charges</span>
          <CardTitle className="text-[17px]" id="inspection-charges-title">Charges &amp; pet review</CardTitle>
          <CardDescription>
            A reviewer confirms unique unauthorized pets and finalizes charges — nothing is
            auto-approved.
          </CardDescription>
        </div>
        <Link className={buttonVariants({ variant: 'secondary' })} href={`/inspections/${inspectionId}/charge-report`}>
          View report
        </Link>
        </CardHeader>

      <ChargeRuleBanner rule={petRule} canConfigure={canConfigure} />

      {isOccupied ? (
        <div className="charges-subsection">
          <div className="charges-subhead">
            <h3>Pet review</h3>
            <button
              type="button"
              className={buttonVariants({ variant: 'secondary' })}
              disabled={mutations.generatePetCandidates.isPending}
              onClick={() => mutations.generatePetCandidates.mutate({ id: inspectionId })}
            >
              {mutations.generatePetCandidates.isPending ? 'Grouping…' : 'Group observations'}
            </button>
          </div>
          {pets.isLoading ? (
            <LoadingState label="Loading pet review…" />
          ) : pets.isError ? (
            <ErrorState error={pets.error} retry={() => void pets.refetch()} />
          ) : pets.data?.candidates.length ? (
            <ul className="pet-candidate-list">
              {pets.data.candidates.map((candidate) => (
                <PetCandidateRow
                  key={candidate.id}
                  inspectionId={inspectionId}
                  candidate={candidate}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              {pets.data?.observations.length
                ? `${pets.data.observations.length} observation(s) recorded — group them into unique animals to review.`
                : 'No pet observations were recorded for this inspection.'}
            </p>
          )}
        </div>
      ) : null}

      <div className="charges-subsection">
        <div className="charges-subhead">
          <h3>Charges</h3>
          <div className="charges-subhead-actions">
            {isOccupied ? (
              <button
                type="button"
                className={buttonVariants({ variant: 'secondary' })}
                disabled={mutations.generateCharges.isPending}
                onClick={() => mutations.generateCharges.mutate({ id: inspectionId })}
              >
                {mutations.generateCharges.isPending ? 'Generating…' : 'Generate pet charges'}
              </button>
            ) : null}
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={() => setAddingCharge(true)}>
              Add charge
            </button>
          </div>
        </div>
        {mutations.generateCharges.error ? (
          <FieldError>{mutations.generateCharges.error.message}</FieldError>
        ) : null}
        {charges.isLoading ? (
          <LoadingState label="Loading charges…" />
        ) : charges.isError ? (
          <ErrorState error={charges.error} retry={() => void charges.refetch()} />
        ) : charges.data?.length ? (
          <ul className="charge-list">
            {charges.data.map((charge) => (
              <ChargeRow key={charge.id} inspectionId={inspectionId} charge={charge} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">No charges have been proposed.</p>
        )}
      </div>

      {addingCharge ? (
        <AddChargeDialog inspectionId={inspectionId} onClose={() => setAddingCharge(false)} />
      ) : null}
      </section>
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
    <div className="charge-rule-banner">
      <div>
        <strong>Unauthorized pet charge</strong>
        <span className="text-xs text-muted-foreground">
          {rule
            ? ` ${money(rule.amount, rule.currency)} per unique pet${rule.isActive ? '' : ' (inactive)'}`
            : ' not configured'}
        </span>
      </div>
      {canConfigure ? (
        editing ? (
          <form
            className="charge-rule-form"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(
                { code: 'UNAUTHORIZED_PET', amount: Number(amount), isActive: true },
                { onSuccess: () => setEditing(false) },
              );
            }}
          >
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-label="Charge amount"
            />
            <button className={buttonVariants({ variant: 'primary' })} disabled={mutation.isPending}>
              Save
            </button>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={() => setEditing(true)}>
            {rule ? 'Edit amount' : 'Configure'}
          </button>
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
    <li className="pet-candidate-item">
      <div className="pet-candidate-main">
        <strong>{candidate.label}</strong>
        <span className="text-xs text-muted-foreground">
          {' '}
          {candidate.species} · {candidate.observationCount} observation
          {candidate.observationCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="pet-candidate-controls">
        <label className="visually-hidden" htmlFor={`rs-${candidate.id}`}>
          Review status
        </label>
        <Select
          onValueChange={(next) =>
            setReviewStatus(next as AdminPetCandidate['reviewStatus'])
          }
          value={reviewStatus}
        >
          <SelectTrigger id={`rs-${candidate.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status.replaceAll('_', ' ').toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="visually-hidden" htmlFor={`as-${candidate.id}`}>
          Authorization
        </label>
        <Select
          onValueChange={(next) =>
            setAuthorizationStatus(next as AdminPetCandidate['authorizationStatus'])
          }
          value={authorizationStatus}
        >
          <SelectTrigger id={`as-${candidate.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status.toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          className={buttonVariants({ variant: 'primary' })}
          disabled={!dirty || mutation.isPending}
          onClick={() =>
            mutation.mutate({ inspectionId, candidateId: candidate.id, reviewStatus, authorizationStatus })
          }
        >
          Save
        </button>
      </div>
    </li>
  );
}

const CHARGE_STATUS_TONE: Record<string, string> = {
  APPROVED: 'charge-chip--approved',
  ADJUSTED: 'charge-chip--approved',
  REJECTED: 'charge-chip--rejected',
  WAIVED: 'charge-chip--rejected',
};

function ChargeRow({ inspectionId, charge }: { inspectionId: string; charge: AdminCharge }) {
  const mutation = useAdminMutations().reviewCharge;
  const [adjusting, setAdjusting] = useState(false);
  const [amount, setAmount] = useState(String(charge.proposedAmount));
  const decided = ['APPROVED', 'REJECTED', 'ADJUSTED', 'WAIVED'].includes(charge.status);

  return (
    <li className="charge-item">
      <div className="charge-main">
        <strong>{charge.description}</strong>
        <div className="text-xs text-muted-foreground">
          {charge.chargeCode} · proposed {money(charge.proposedAmount, charge.currency)}
          {charge.approvedAmount !== null && charge.approvedAmount !== undefined
            ? ` · approved ${money(charge.approvedAmount, charge.currency)}`
            : ''}
          {' · '}
          <span title="Origin of this charge">{charge.source.replaceAll('_', ' ').toLowerCase()}</span>
        </div>
      </div>
      <div className="charge-controls">
        <span className={`charge-chip ${CHARGE_STATUS_TONE[charge.status] ?? ''}`}>
          {charge.status.replaceAll('_', ' ').toLowerCase()}
        </span>
        {!decided ? (
          <>
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'primary' }), 'charge-action')}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({ inspectionId, chargeId: charge.id, decision: 'APPROVE' })
              }
            >
              Approve
            </button>
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'secondary' }), 'charge-action')}
              onClick={() => setAdjusting((value) => !value)}
            >
              Adjust
            </button>
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'secondary' }), 'charge-action')}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({ inspectionId, chargeId: charge.id, decision: 'WAIVE' })
              }
            >
              Waive
            </button>
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'secondary' }), 'charge-action')}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({ inspectionId, chargeId: charge.id, decision: 'REJECT' })
              }
            >
              Reject
            </button>
          </>
        ) : null}
      </div>
      {adjusting ? (
        <form
          className="charge-adjust-form"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(
              { inspectionId, chargeId: charge.id, decision: 'ADJUST', approvedAmount: Number(amount) },
              { onSuccess: () => setAdjusting(false) },
            );
          }}
        >
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-label="Adjusted amount"
          />
          <button className={buttonVariants({ variant: 'primary' })} disabled={mutation.isPending}>
            Save adjusted
          </button>
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      id: inspectionId,
      description: description.trim(),
      unitAmount: Number(unitAmount),
      reason: reason.trim() || undefined,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a charge</DialogTitle>
            <DialogDescription>
              Manually proposed charges start as pending review — they are not approved until
              reviewed.
            </DialogDescription>
          </DialogHeader>
        <Field asChild>
<label>
          <span>Description</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} required />
        </label>
</Field>
        <Field asChild>
<label>
          <span>Amount</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={unitAmount}
            onChange={(event) => setUnitAmount(event.target.value)}
            required
          />
        </label>
</Field>
        <Field asChild>
<label>
          <span>Reason (optional)</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
        </label>
</Field>
        {mutation.error ? <FieldError>{mutation.error.message}</FieldError> : null}
          <DialogFooter>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={onClose}>
              Cancel
            </button>
            <button
              className={buttonVariants({ variant: 'primary' })}
              disabled={mutation.isPending || !description.trim() || !unitAmount}
            >
              {mutation.isPending ? 'Adding…' : 'Add charge'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

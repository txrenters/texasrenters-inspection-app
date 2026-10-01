'use client';

import {
  propertyDetailSections,
  type AdminProperty,
  type PropertyDetailsView,
  type PropertyOwnerView,
} from '@texasrenters/shared';
import { EyeIcon, EyeOffIcon, LockIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EMPTY, formatCurrency, formatDate, formatRelative } from '@/lib/format';
import { usePropertyPrivateDetails } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * Everything Propertyware holds on a property, on its Details tab (the office,
 * 2026-10-01: "include all the details that is needed that is most likely
 * updates the most").
 *
 * The office's custom fields lead, in the order they change -- status and make
 * ready, then the benefit package and HVAC, then utilities -- with the
 * building record after. Every field is listed whether or not it is filled, so
 * what nobody has entered yet is visible rather than missing. The access codes
 * and the owners' phones are behind "Show", for people who manage properties.
 */
export function PropertyDetailsPanel({
  property,
  canSeePrivate,
}: {
  property: Pick<AdminProperty, 'id' | 'details' | 'owner'>;
  canSeePrivate: boolean;
}) {
  const details = property.details;
  if (!details)
    return (
      <EmptyState
        description="The next Propertyware sync brings in this property's details: occupancy, make ready, utilities, filters and the rest."
        title="Details not synchronized yet"
      />
    );

  return (
    <div className="grid gap-4">
      {details.updated.at ? (
        <p className="text-muted-foreground text-xs">
          Last changed in Propertyware {formatRelative(details.updated.at)}
          {details.updated.by ? ` by ${details.updated.by}` : ''} · {formatDate(details.updated.at)}
        </p>
      ) : null}

      {/* Two columns that each stack their cards, rather than a grid of rows:
          the cards differ in height, and rows left a gap under every short one. */}
      <div className="gap-4 lg:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
        {/* First: the lockbox and gate codes are what the office looks up most. */}
        <PrivateCard
          accessOnFile={details.accessFieldsOnFile}
          canSee={canSeePrivate}
          owner={property.owner ?? null}
          propertyId={property.id}
        />
        {propertyDetailSections(details.customFields).map((section) => (
          <DetailCard
            count={`${section.rows.filter((row) => row.value !== null).length} of ${section.rows.length}`}
            key={section.title}
            title={section.title}
          >
            {section.rows.map((row) => (
              <DetailRow key={row.name} label={row.label}>
                {row.value}
              </DetailRow>
            ))}
          </DetailCard>
        ))}

        <LeasingCard leasing={details.leasing} />
        <BuildingCard building={details.building} />
        <ManagementCard management={details.management} owner={property.owner ?? null} />
      </div>
    </div>
  );
}

function LeasingCard({ leasing }: { leasing: PropertyDetailsView['leasing'] }) {
  return (
    <DetailCard title="Leasing">
      <DetailRow label="Status">{leasing.status}</DetailRow>
      <DetailRow label="Ready">{yesNo(leasing.ready)}</DetailRow>
      <DetailRow label="Available">{leasing.availableDate ? formatDate(leasing.availableDate) : null}</DetailRow>
      <DetailRow label="Target rent">{leasing.targetRent ? formatCurrency(leasing.targetRent) : null}</DetailRow>
      <DetailRow label="Target deposit">{leasing.targetDeposit ? formatCurrency(leasing.targetDeposit) : null}</DetailRow>
      <DetailRow label="Pets allowed">{yesNo(leasing.petsAllowed)}</DetailRow>
      <DetailRow label="Smoking allowed">{yesNo(leasing.smokingAllowed)}</DetailRow>
      <DetailRow label="Published for rent">{yesNo(leasing.publishedForRent)}</DetailRow>
      <DetailRow label="Listing title">{leasing.postingTitle}</DetailRow>
      <DetailRow label="Description" long>
        {leasing.description}
      </DetailRow>
      <DetailRow label="Comments" long>
        {leasing.comments}
      </DetailRow>
    </DetailCard>
  );
}

function BuildingCard({ building }: { building: PropertyDetailsView['building'] }) {
  return (
    <DetailCard title="Building">
      <DetailRow label="Bedrooms">{building.bedrooms}</DetailRow>
      <DetailRow label="Bathrooms">{building.bathrooms}</DetailRow>
      <DetailRow label="Year built">{building.yearBuilt}</DetailRow>
      <DetailRow label="Floors">{building.floors}</DetailRow>
      <DetailRow label="Neighborhood">{building.neighborhood}</DetailRow>
      <DetailRow label="County">{building.county}</DetailRow>
      <DetailRow label="Parcel number">{building.parcelNumber}</DetailRow>
      <DetailRow label="Amenities">{building.amenities.length ? building.amenities.join(', ') : null}</DetailRow>
    </DetailCard>
  );
}

function ManagementCard({
  management,
  owner,
}: {
  management: PropertyDetailsView['management'];
  owner: PropertyOwnerView | null;
}) {
  return (
    <DetailCard title="Management & owner">
      <DetailRow label="Owners">{owner?.owners}</DetailRow>
      <DetailRow label="Portfolio">{owner?.portfolioName}</DetailRow>
      <DetailRow label="First agreement signed">
        {owner?.managementAgreementSignedOn ? formatDate(owner.managementAgreementSignedOn) : null}
      </DetailRow>
      <DetailRow label="Contract start">{management.contractStart ? formatDate(management.contractStart) : null}</DetailRow>
      <DetailRow label="Contract end">{management.contractEnd ? formatDate(management.contractEnd) : null}</DetailRow>
      <DetailRow label="Maintenance limit">
        {management.maintenanceLimit
          ? `${formatCurrency(management.maintenanceLimit)}${management.maintenanceLimitPeriod ? ` ${management.maintenanceLimitPeriod.toLowerCase()}` : ''}`
          : null}
      </DetailRow>
      <DetailRow label="Maintenance notice" long>
        {management.maintenanceNotice}
      </DetailRow>
      <DetailRow label="Property managers">
        {management.managers.length
          ? management.managers.map((manager) => (manager.role ? `${manager.name} (${manager.role})` : manager.name)).join(', ')
          : null}
      </DetailRow>
    </DetailCard>
  );
}

/**
 * The lockbox, gate, alarm and garage codes, and the owners' phones.
 *
 * Fetched only when "Show" is pressed, and only offered to people who manage
 * properties; everyone else is told the codes are on file without seeing them.
 */
function PrivateCard({
  propertyId,
  canSee,
  accessOnFile,
  owner,
}: {
  propertyId: string;
  canSee: boolean;
  accessOnFile: number;
  owner: PropertyOwnerView | null;
}) {
  const [shown, setShown] = useState(false);
  const secret = usePropertyPrivateDetails(propertyId, canSee && shown);
  const onFile = accessOnFile > 0 || Boolean(owner?.phonesOnFile);

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LockIcon className="text-muted-foreground size-4" />
          Access & owner phones
        </CardTitle>
        {canSee && onFile ? (
          <CardAction>
            <Button onClick={() => setShown((was) => !was)} size="sm" variant="outline">
              {shown ? <EyeOffIcon /> : <EyeIcon />}
              {shown ? 'Hide' : 'Show'}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {!onFile ? (
          <p className="text-muted-foreground text-sm">No access codes or owner phones on file.</p>
        ) : !canSee ? (
          <p className="text-muted-foreground text-sm">
            {accessOnFile ? `${accessOnFile} access ${accessOnFile === 1 ? 'code' : 'codes'} on file. ` : ''}
            Only people who manage properties can see the codes and the owners&apos; phones.
          </p>
        ) : !shown ? (
          <p className="text-muted-foreground text-sm">
            {accessOnFile ? `${accessOnFile} access ${accessOnFile === 1 ? 'entry' : 'entries'}` : 'No access codes'}
            {owner?.phonesOnFile ? ' and the owners’ phones' : ''} on file. Press Show to see them.
          </p>
        ) : secret.isError ? (
          <ErrorState error={secret.error} retry={() => void secret.refetch()} />
        ) : !secret.data ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">
            {secret.data.access.map((field) => (
              <DetailPair key={field.name} label={field.label} long>
                {field.value}
              </DetailPair>
            ))}
            {secret.data.ownerPhones?.mobile ? (
              <DetailPair label="Owner mobile">{secret.data.ownerPhones.mobile}</DetailPair>
            ) : null}
            {secret.data.ownerPhones?.home ? (
              <DetailPair label="Owner home phone">{secret.data.ownerPhones.home}</DetailPair>
            ) : null}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function DetailCard({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {count ? (
          <CardAction>
            <Badge title="Fields filled in Propertyware" variant="secondary">
              {count}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">{children}</dl>
      </CardContent>
    </Card>
  );
}

/** One field: its value, or a muted dash when nothing usable is on file. */
function DetailRow({ label, children, long }: { label: string; children: ReactNode; long?: boolean }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <DetailPair label={label} long={long} muted={empty}>
      {empty ? EMPTY : children}
    </DetailPair>
  );
}

function DetailPair({
  label,
  children,
  long,
  muted,
}: {
  label: string;
  children: ReactNode;
  long?: boolean;
  muted?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground text-xs font-medium sm:pt-0.5">{label}</dt>
      <dd
        className={cn(
          'min-w-0 break-words',
          long && 'whitespace-pre-line',
          muted ? 'text-muted-foreground' : 'font-medium',
        )}
      >
        {children}
      </dd>
    </>
  );
}

function yesNo(value: boolean | null): string | null {
  return value === null ? null : value ? 'Yes' : 'No';
}

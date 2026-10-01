import {
  customFieldLabel,
  isAccessField,
  isPlaceholderValue,
  type PropertyDetailsSnapshot,
  type PropertyDetailsView,
  type PropertyOwnerDetails,
  type PropertyOwnerView,
  type PropertyPrivateDetails,
} from '@texasrenters/shared';

/**
 * What the property page may show anyone who reads properties: the details
 * without the access codes, the owners without their phones.
 *
 * The split is made here, on the server, and the page's cached response is
 * built from this alone -- so a lockbox code is never in the shared cache, and
 * never reaches a browser that did not ask for it with the right to see it
 * (`privateDetails`).
 */
export function detailsView(stored: unknown): PropertyDetailsView | null {
  const details = snapshot(stored);
  if (!details) return null;
  const access = details.customFields.filter((field) => isAccessField(field.name));
  return {
    ...details,
    customFields: details.customFields.filter((field) => !isAccessField(field.name)),
    accessFieldsOnFile: access.filter((field) => !isPlaceholderValue(field.value)).length,
  };
}

export function ownerView(stored: unknown): PropertyOwnerView | null {
  const owner = ownerDetails(stored);
  if (!owner) return null;
  return {
    owners: owner.owners,
    portfolioName: owner.portfolioName,
    managementAgreementSignedOn: owner.managementAgreementSignedOn,
    phonesOnFile: Boolean(owner.mobilePhones || owner.homePhones),
  };
}

/** The access codes and owner phones: for someone who manages properties, asked for on its own. */
export function privateDetails(storedDetails: unknown, storedOwner: unknown): PropertyPrivateDetails {
  const details = snapshot(storedDetails);
  const owner = ownerDetails(storedOwner);
  return {
    access: (details?.customFields ?? [])
      .filter((field) => isAccessField(field.name) && !isPlaceholderValue(field.value))
      .map((field) => ({ name: field.name, label: customFieldLabel(field.name), value: field.value.trim() })),
    ownerPhones:
      owner && (owner.mobilePhones || owner.homePhones)
        ? { mobile: owner.mobilePhones, home: owner.homePhones }
        : null,
  };
}

/** The stored JSON, when it is a snapshot; anything else reads as none rather than breaking the page. */
function snapshot(stored: unknown): PropertyDetailsSnapshot | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const details = stored as Partial<PropertyDetailsSnapshot>;
  if (!details.building || !details.leasing || !details.management || !Array.isArray(details.customFields)) return null;
  return details as PropertyDetailsSnapshot;
}

function ownerDetails(stored: unknown): PropertyOwnerDetails | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  return stored as PropertyOwnerDetails;
}

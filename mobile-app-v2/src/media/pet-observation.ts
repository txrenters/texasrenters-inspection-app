import { requestJson } from '../repositories/api/repositories';

/**
 * A technician's pet observation during an occupied inspection (spec §13).
 * Evidence only — the technician never determines uniqueness, authorization, or
 * any charge; an administrator reviews that on the web console.
 */
export type PetObservationInput = {
  inspectionId: string;
  temporaryLabel: string;
  species: string;
  characteristics?: string;
  notes?: string;
};

export async function recordPetObservation({ inspectionId, ...body }: PetObservationInput) {
  return requestJson(
    `/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/pet-observations`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

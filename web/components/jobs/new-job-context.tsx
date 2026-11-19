'use client';

import type { JobInspectionType } from '@texasrenters/shared';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

import { NewJobSheet } from './new-job-sheet';

/**
 * What the New job panel starts from (2026-11-20, phase 2 of the jobs plan):
 * the day right-clicked on the Schedule, the inspection a Create tile names,
 * the property a property page is about. Prefills, never locks.
 */
export interface NewJobPrefill {
  /** "2026-11-23". Today in Texas when absent. */
  date?: string;
  technicianId?: string;
  propertyId?: string;
  inspectionTypes?: JobInspectionType[];
  /** Said under the title: "from the Schedule". */
  from?: string;
}

type OpenNewJob = (prefill?: NewJobPrefill) => void;

const NewJobContext = createContext<OpenNewJob | null>(null);

/**
 * Holds the one New job panel every page opens. The panel is mounted only while
 * it is open, fresh each time, so nothing is asked of the API until somebody
 * opens it and a closed one keeps nothing typed into it.
 */
export function NewJobProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<{ key: number; prefill: NewJobPrefill } | null>(null);
  const open = useCallback<OpenNewJob>((prefill = {}) => setOpened({ key: Date.now(), prefill }), []);
  return (
    <NewJobContext.Provider value={open}>
      {children}
      {opened ? <NewJobSheet key={opened.key} onClose={() => setOpened(null)} prefill={opened.prefill} /> : null}
    </NewJobContext.Provider>
  );
}

/** Opens the New job panel. Needs `NewJobProvider` above it, which the console's shell gives every page. */
export function useNewJob(): OpenNewJob {
  const open = useContext(NewJobContext);
  if (!open) throw new Error('useNewJob is used outside NewJobProvider.');
  return open;
}

'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { EvidenceViewer, type EvidenceViewerItem } from '@/components/area-evidence/EvidenceViewer';
import { LazyPhoto } from '@/components/area-evidence/LazyPhoto';

/**
 * The photographs a technician took for the job's services, beside the answers.
 *
 * The office asked to see each filter's photograph next to its register rather
 * than hunting for it in the AC filters area (2026-09-18), and pest control's
 * optional one beside pest control. Thumbnails only, fetched as they come into
 * view.
 *
 * A thumbnail opens the console's one photo viewer (2026-11-26, approved on
 * the canvas): zoom, turn, Download, and every job photograph of the visit in
 * the order of its cards, so the arrows walk from the filters to pest control
 * without closing it. It opened in a plain box before, with none of that.
 */

export interface ServicePhoto {
  id: string;
  /** What it is a photograph of: "20x25x1 · upstairs hallway", "Pest control". */
  label: string;
  /** A filter's is of its printed size; a treatment's is simply a photograph. */
  captureType: 'SERIAL_OR_LABEL' | 'OTHER';
  /** The work it is for, which titles it in the viewer: "AC filter change". The label when not given. */
  title?: string;
  /** Read beside the title in the viewer: how the work went, "Done" or "Not done". The label when not given. */
  detail?: string | null;
}

const contentPath = (id: string) => `/api/v1/admin/photos/${id}/content`;
/** A filter label reads at 1,600 pixels; the original can be ten times the bytes. */
const PREVIEW_WIDTH = 1600;

/** How the viewer shows one job photograph. */
function viewerItem(photo: ServicePhoto, context: JobPhotoContext): EvidenceViewerItem {
  const title = photo.title ?? photo.label;
  return {
    id: photo.id,
    kind: 'photo',
    contentPath: contentPath(photo.id),
    previewPath: `${contentPath(photo.id)}?w=${PREVIEW_WIDTH}`,
    title,
    detail: photo.detail ?? (photo.label !== title ? photo.label : null),
    caption: context.caption ?? undefined,
    day: context.day,
  };
}

interface JobPhotoContext {
  /** "2210 Cedar Bend Dr Unit B · Work done reported Mon Nov 23, 10:41 AM · D. Ramos" */
  caption?: string | null;
  /** The property, leading a downloaded file's name. */
  place?: string | null;
  /** The Texas day the work was reported, for the file name, `yyyy-MM-dd`. */
  day?: string | null;
}

const JobPhotos = createContext<{ open: (id: string) => void } | null>(null);

/**
 * One viewer for every job photograph of a visit. The cards inside it each show
 * their own thumbnails; any of them opens this viewer on that photograph.
 */
export function JobPhotosViewer({
  photos,
  children,
  ...context
}: JobPhotoContext & { photos: ServicePhoto[]; children: ReactNode }) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const { caption, day, place } = context;
  const items = useMemo(
    () => photos.map((photo) => viewerItem(photo, { caption, day })),
    [caption, day, photos],
  );
  const value = useMemo(
    () => ({
      open: (id: string) => {
        const at = items.findIndex((item) => item.id === id);
        if (at !== -1) setOpenAt(at);
      },
    }),
    [items],
  );
  return (
    <JobPhotos.Provider value={value}>
      {children}
      {openAt !== null ? (
        <EvidenceViewer items={items} onClose={() => setOpenAt(null)} place={place} startIndex={openAt} />
      ) : null}
    </JobPhotos.Provider>
  );
}

export function ServicePhotos({ photos, areaName }: { photos: ServicePhoto[]; areaName: string }) {
  const visit = useContext(JobPhotos);
  // On its own, outside a visit's cards: a viewer of just these.
  const [openAt, setOpenAt] = useState<number | null>(null);
  if (!photos.length) return null;

  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {photos.map((photo, index) => (
          <LazyPhoto
            areaName={areaName}
            // No caption: each sits in the card of what it shows, which says so (2026-11-06).
            // The label stays in the button's name and over the full image.
            compact
            key={photo.id}
            onOpen={() => (visit ? visit.open(photo.id) : setOpenAt(index))}
            photo={{ contentPath: contentPath(photo.id), captureType: photo.captureType, label: photo.label }}
          />
        ))}
      </div>
      {!visit && openAt !== null ? (
        <EvidenceViewer
          items={photos.map((photo) => viewerItem(photo, {}))}
          onClose={() => setOpenAt(null)}
          startIndex={openAt}
        />
      ) : null}
    </>
  );
}

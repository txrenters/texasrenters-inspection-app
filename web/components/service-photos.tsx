'use client';

import { useEffect, useState } from 'react';

import { LazyPhoto } from '@/components/area-evidence/LazyPhoto';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiBlob } from '@/lib/api';

/**
 * The photographs a technician took for the job's services, beside the answers.
 *
 * The office asked to see each filter's photograph next to its register rather
 * than hunting for it in the AC filters area (2026-09-18), and pest control's
 * optional one beside pest control. Thumbnails only, fetched as they come into
 * view; the full image opens in place.
 */

export interface ServicePhoto {
  id: string;
  /** What it is a photograph of: "20x25x1 · upstairs hallway", "Pest control". */
  label: string;
  /** A filter's is of its printed size; a treatment's is simply a photograph. */
  captureType: 'SERIAL_OR_LABEL' | 'OTHER';
}

const contentPath = (id: string) => `/api/v1/admin/photos/${id}/content`;

/** The full-size photograph, fetched with the console's own session. */
function PhotoPreview({ photo, onClose }: { photo: ServicePhoto | null; onClose: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!photo) return;
    let url: string | null = null;
    const controller = new AbortController();
    setObjectUrl(null);
    setFailed(false);
    // A bounded variant: a filter label reads at 1600 pixels, and the original
    // can be ten times the bytes.
    apiBlob(`${contentPath(photo.id)}?w=1600`, controller.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [photo]);

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open={Boolean(photo)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{photo?.label}</DialogTitle>
          <DialogDescription>Photographed by the technician on the job.</DialogDescription>
        </DialogHeader>
        {objectUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={photo?.label ?? ''} className="max-h-[70vh] w-full rounded-lg object-contain" src={objectUrl} />
        ) : (
          <p className="text-muted-foreground py-10 text-center text-sm">
            {failed ? 'The photograph could not be loaded.' : 'Loading…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ServicePhotos({ photos, areaName }: { photos: ServicePhoto[]; areaName: string }) {
  const [open, setOpen] = useState<ServicePhoto | null>(null);
  if (!photos.length) return null;

  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {photos.map((photo) => (
          <LazyPhoto
            areaName={areaName}
            key={photo.id}
            onOpen={() => setOpen(photo)}
            photo={{ contentPath: contentPath(photo.id), captureType: photo.captureType, label: photo.label }}
          />
        ))}
      </div>
      <PhotoPreview onClose={() => setOpen(null)} photo={open} />
    </>
  );
}

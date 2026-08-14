'use client';

import { CameraIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useAdminMutations } from '@/lib/queries';
import type { AreaChecklistEntry } from '@texasrenters/shared';

/** Radix Select rejects an empty value; this is the "not an item" sentinel. */
const NO_ITEM = '__none__';

function stamp(atMs: number) {
  const total = Math.round(atMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The moments the technician flagged while recording, and a way to turn one
 * into report evidence.
 *
 * Android cannot photograph during video capture — expo-camera binds either the
 * image or the video use case, never both — so the shutter has always stored a
 * timestamp rather than a picture. The pipeline was meant to cut those frames
 * out afterwards and never did for a Cloudflare Stream recording, which is
 * every recording: the extraction sits below an early return. So every marker a
 * technician has ever set has gone nowhere.
 *
 * Capturing here instead is better than fixing it there. The reviewer is at a
 * desk with the recording in front of them, so they choose the frame; and
 * Cloudflare renders it from the signed thumbnail endpoint at any offset, so
 * nothing has to download the video.
 */
export function RecordingMarkers({
  mediaId,
  inspectionId,
  areaId,
  markers,
  checklist,
  onSeek,
}: {
  mediaId: string;
  inspectionId: string;
  areaId: string;
  markers: number[];
  checklist: AreaChecklistEntry[];
  /** Jumps the player to a moment, so the reviewer can look before capturing. */
  onSeek: (seconds: number) => void;
}) {
  const mutations = useAdminMutations();
  const [itemId, setItemId] = useState(NO_ITEM);
  const [capturing, setCapturing] = useState<number | null>(null);
  const capture = mutations.captureSnapshot;

  if (!markers.length) return null;

  return (
    <section aria-labelledby={`markers-${mediaId}`} className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium" id={`markers-${mediaId}`}>
            Technician markers
          </h4>
          <p className="text-muted-foreground text-xs">
            Moments flagged during the walkthrough. Capture one to add it to the report.
          </p>
        </div>
        {/* One selector for the whole strip rather than per marker: a reviewer
            works through an item and captures several frames of it, so asking
            once matches how the job is actually done. */}
        <Select onValueChange={setItemId} value={itemId}>
          <SelectTrigger aria-label="Attach captures to a checklist item" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ITEM}>No checklist item</SelectItem>
            {checklist.map((entry) => (
              <SelectItem key={entry.itemId} value={entry.itemId}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ul className="flex flex-wrap gap-2">
        {markers.map((atMs) => (
          <li className="flex items-center overflow-hidden rounded-md border" key={atMs}>
            {/* Seek and capture are separate controls on purpose: a reviewer
                should be able to look at the moment before deciding it belongs
                in a report handed to a tenant. */}
            <button
              className="hover:bg-muted px-2.5 py-1.5 font-mono text-xs"
              onClick={() => onSeek(atMs / 1000)}
              type="button"
            >
              {stamp(atMs)}
            </button>
            <Button
              aria-label={`Capture the frame at ${stamp(atMs)}`}
              className="rounded-none border-0 border-l"
              disabled={capture.isPending}
              onClick={() => {
                setCapturing(atMs);
                capture.mutate(
                  {
                    mediaId,
                    inspectionId,
                    areaId,
                    atMs,
                    ...(itemId === NO_ITEM ? {} : { checklistItemId: itemId }),
                  },
                  { onSettled: () => setCapturing(null) },
                );
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {capturing === atMs ? <Spinner /> : <CameraIcon />}
            </Button>
          </li>
        ))}
      </ul>

      {capture.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {capture.error instanceof Error
              ? capture.error.message
              : 'The frame could not be captured.'}
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

'use client';

import { DownloadIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAdminMutations } from '@/lib/queries';

/** How often to ask again while Cloudflare makes the file. */
export const DOWNLOAD_POLL_MS = 3_000;
/** About three minutes, as long as the server itself waits for one. */
const MAX_ATTEMPTS = 60;

/**
 * Hands a signed link to the browser as a download.
 *
 * Followed in this tab rather than a new one: Cloudflare answers the link as an
 * attachment, so the page stays where it is and the file arrives in the
 * browser's downloads. A new tab opened after the request returns is what a
 * popup blocker stops.
 */
function saveFrom(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * "Download" for one recording: saves it as an MP4 file.
 *
 * The office had no way to keep a copy of a walkthrough (2026-10-28), not even
 * full screen: the player is Cloudflare's, embedded, and offers none. The server
 * checks the reviewer may watch the recording and answers with a link signed
 * for a few minutes. Most recordings already have their file, made for the
 * transcript; for one that does not, Cloudflare makes it first, and the button
 * says how far along it is while it asks again.
 */
export function RecordingDownloadButton({
  mediaId,
  className,
}: {
  mediaId: string;
  className?: string;
}) {
  const request = useAdminMutations().downloadRecording.mutateAsync;
  const [working, setWorking] = useState<{ percent: number | null } | null>(null);
  // Polling stops when the card goes away: an area switched mid-wait must not
  // start a download the reviewer has moved on from.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = async () => {
    setWorking({ percent: null });
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const result = await request({ mediaId });
        if (!mounted.current) return;
        if (result.status === 'ready') {
          saveFrom(result.url);
          return;
        }
        if (result.status === 'processing') {
          toast.info('Cloudflare is still processing this recording. Try again in a few minutes.');
          return;
        }
        if (result.status === 'unavailable') {
          toast.error(result.message);
          return;
        }
        setWorking({ percent: result.percentComplete });
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_POLL_MS));
        if (!mounted.current) return;
      }
      toast.info('The file is taking longer than usual to prepare. Try again in a minute.');
    } catch (error) {
      if (mounted.current)
        toast.error(error instanceof Error ? error.message : 'The recording could not be downloaded.');
    } finally {
      if (mounted.current) setWorking(null);
    }
  };

  return (
    <Button
      aria-label={working ? 'Preparing the recording to download' : 'Download recording'}
      className={className}
      disabled={Boolean(working)}
      onClick={() => void start()}
      size="sm"
      type="button"
      variant="outline"
    >
      {working ? <Spinner aria-hidden className="size-3" /> : <DownloadIcon aria-hidden />}
      {working
        ? working.percent != null
          ? `Preparing ${Math.round(working.percent)}%`
          : 'Preparing…'
        : 'Download'}
    </Button>
  );
}

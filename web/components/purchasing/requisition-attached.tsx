'use client';

import {
  REQUISITION_LINK_TITLE_MAX_LENGTH,
  REQUISITION_NOTE_MAX_LENGTH,
  requisitionLinkUrl,
  type RequisitionDetail,
  type RequisitionLink,
  type RequisitionNote,
} from '@texasrenters/shared';
import { ExternalLinkIcon, XIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { FactBox, FastTab } from '@/components/purchasing/nav-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { useRequisitionNotes } from '@/lib/purchasing-queries';

/**
 * The ribbon's "Show Attached" (2026-11-20): Notes and Links as FactBoxes, and
 * Comments as a thread under the lines. Anybody who sees the requisition adds
 * to them; a note or link comes off by whoever put it there, and a comment
 * stays. A requisition not yet saved has nowhere to keep them, so it says so.
 */

const said = (error: unknown) => (error instanceof Error ? error.message : 'It could not be done.');
const SAVE_FIRST = 'Save the requisition first.';

function Byline({ note }: { note: Pick<RequisitionNote, 'by' | 'at'> }) {
  return (
    <span className="text-muted-foreground text-xs">
      {note.by.code} · {formatDateTime(note.at)}
    </span>
  );
}

export function NotesFactBox({ requisition, id }: { requisition?: RequisitionDetail; id?: string }) {
  return (
    <FactBox id={id} title={`Notes${requisition?.notes.length ? ` (${requisition.notes.length})` : ''}`}>
      {requisition ? <Notes requisition={requisition} /> : <p className="text-muted-foreground text-xs">{SAVE_FIRST}</p>}
    </FactBox>
  );
}

function Notes({ requisition }: { requisition: RequisitionDetail }) {
  const { addNote, removeNote } = useRequisitionNotes(requisition.id);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setProblem(null);
    addNote.mutate(text.trim(), { onSuccess: () => setText(''), onError: (error) => setProblem(said(error)) });
  };
  return (
    <div className="grid gap-2">
      {requisition.notes.length ? (
        <ul aria-label="Notes" className="grid gap-2">
          {requisition.notes.map((note) => (
            <li className="grid gap-0.5 border-b pb-2 last:border-0 last:pb-0" key={note.id}>
              <div className="flex items-start gap-2">
                <p className="flex-1 whitespace-pre-wrap">{note.text}</p>
                {note.canRemove ? (
                  <Button aria-label="Take this note off" className="size-6 shrink-0" disabled={removeNote.isPending} onClick={() => removeNote.mutate(note.id, { onError: (error) => setProblem(said(error)) })} size="icon" type="button" variant="ghost">
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <Byline note={note} />
            </li>
          ))}
        </ul>
      ) : null}
      <form className="grid gap-1.5" onSubmit={submit}>
        <Textarea aria-label="Write a note" maxLength={REQUISITION_NOTE_MAX_LENGTH} onChange={(event) => setText(event.target.value)} placeholder="Write a note" rows={2} value={text} />
        <Button className="justify-self-end" disabled={!text.trim() || addNote.isPending} size="sm" type="submit" variant="outline">
          Add Note
        </Button>
      </form>
      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function LinksFactBox({ requisition, id }: { requisition?: RequisitionDetail; id?: string }) {
  return (
    <FactBox id={id} title={`Links${requisition?.links.length ? ` (${requisition.links.length})` : ''}`}>
      {requisition ? <Links requisition={requisition} /> : <p className="text-muted-foreground text-xs">{SAVE_FIRST}</p>}
    </FactBox>
  );
}

function Links({ requisition }: { requisition: RequisitionDetail }) {
  const { addLink, removeLink } = useRequisitionNotes(requisition.id);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const good = requisitionLinkUrl(url);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!good) return setProblem('A link is a web address starting with https:// or http://.');
    setProblem(null);
    addLink.mutate(
      { url: good, title: title.trim() },
      {
        onSuccess: () => {
          setUrl('');
          setTitle('');
        },
        onError: (error) => setProblem(said(error)),
      },
    );
  };
  return (
    <div className="grid gap-2">
      {requisition.links.length ? (
        <ul aria-label="Links" className="grid gap-2">
          {requisition.links.map((link: RequisitionLink) => (
            <li className="grid gap-0.5 border-b pb-2 last:border-0 last:pb-0" key={link.id}>
              <div className="flex items-start gap-2">
                {/* Only ever an http(s) address: the server and the database both refuse anything else. */}
                <a className="text-info flex min-w-0 flex-1 items-center gap-1 font-medium hover:underline" href={link.url} rel="noopener noreferrer" target="_blank" title={link.url}>
                  <span className="truncate">{link.title}</span>
                  <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
                </a>
                {link.canRemove ? (
                  <Button aria-label={`Take the link ${link.title} off`} className="size-6 shrink-0" disabled={removeLink.isPending} onClick={() => removeLink.mutate(link.id, { onError: (error) => setProblem(said(error)) })} size="icon" type="button" variant="ghost">
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <Byline note={link} />
            </li>
          ))}
        </ul>
      ) : null}
      <form className="grid gap-1.5" onSubmit={submit}>
        <Input aria-label="Link address" className="h-8" inputMode="url" onChange={(event) => setUrl(event.target.value)} placeholder="https://" value={url} />
        <Input aria-label="Link title" className="h-8" maxLength={REQUISITION_LINK_TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} placeholder="Title (the address if left empty)" value={title} />
        <Button className="justify-self-end" disabled={!url.trim() || addLink.isPending} size="sm" type="submit" variant="outline">
          Add Link
        </Button>
      </form>
      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function CommentsTab({ requisition, id }: { requisition?: RequisitionDetail; id?: string }) {
  return (
    <div className="scroll-mt-20" id={id}>
      <FastTab title={`Comments${requisition?.comments.length ? ` (${requisition.comments.length})` : ''}`}>
        {requisition ? <Comments requisition={requisition} /> : <p className="text-muted-foreground text-sm">{SAVE_FIRST}</p>}
      </FastTab>
    </div>
  );
}

function Comments({ requisition }: { requisition: RequisitionDetail }) {
  const { comment } = useRequisitionNotes(requisition.id);
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    comment.mutate(text.trim(), { onSuccess: () => setText('') });
  };
  return (
    <div className="grid gap-3">
      {requisition.comments.length ? (
        <ol aria-label="Comments, oldest first" className="grid gap-2.5">
          {requisition.comments.map((entry) => (
            <li className="grid gap-0.5" key={entry.id}>
              <span className="text-sm">
                <span className="font-medium">{entry.by.name}</span> <Byline note={entry} />
              </span>
              <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground text-sm">No comments yet.</p>
      )}
      <form className="grid gap-1.5" onSubmit={submit}>
        <Textarea aria-label="Write a comment" maxLength={REQUISITION_NOTE_MAX_LENGTH} onChange={(event) => setText(event.target.value)} placeholder="Write a comment" rows={2} value={text} />
        <Button className="justify-self-start" disabled={!text.trim() || comment.isPending} size="sm" type="submit" variant="outline">
          Comment
        </Button>
      </form>
      {comment.error ? (
        <Alert variant="destructive">
          <AlertDescription>{comment.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

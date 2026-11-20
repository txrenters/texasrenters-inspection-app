'use client';

import { BanIcon, CheckIcon, FileCheck2Icon, PrinterIcon, RotateCcwIcon, SaveIcon, SendIcon, ShoppingCartIcon, Undo2Icon, XIcon } from 'lucide-react';

import { Ribbon, RibbonButton, RibbonGroup, RibbonStack } from '@/components/purchasing/nav-kit';

/**
 * The requisition's ribbon, every group the office approved on the canvas
 * (2026-11-20): Manage, Request Approval, Release, Prepare, Order, Print, Show
 * Attached and Page -- with Approve for whoever decides it. A button whose
 * action is not open to this person now is drawn greyed, with why on hover;
 * one the page gives no action at all is left greyed with its reason.
 *
 * It only draws: each action is the page's, and the server decides again.
 */

type Action = (() => void) | undefined;

export interface RequisitionRibbonProps {
  /** Manage */
  onSave?: Action;
  saving?: boolean;
  saveHint?: string;
  onNew: () => void;
  onCopyDocument?: Action;
  onDelete?: Action;
  /** Request Approval */
  onSendApproval?: Action;
  sendHint?: string;
  onCancelApproval?: Action;
  /** Release: approving is what releases a requisition. */
  onRelease?: Action;
  releaseHint?: string;
  onReopen?: Action;
  /** Approve, shown to whoever decides it. */
  deciding?: boolean;
  onSendBack?: Action;
  onReject?: Action;
  /** Prepare */
  onAddLow?: Action;
  onSelectFromCategories?: Action;
  onScan?: Action;
  scanning?: boolean;
  /** Order */
  onMakeOrder?: Action;
  orderHint?: string;
  /** Print */
  onPrint?: Action;
  /** Show Attached */
  shown: { notes: boolean; links: boolean; comments: boolean };
  onToggle: (which: 'notes' | 'links' | 'comments') => void;
  /** Page */
  onPrevious?: Action;
  onNext?: Action;
  onGoTo: () => void;
  busy?: boolean;
}

export function RequisitionRibbon(props: RequisitionRibbonProps) {
  const { busy } = props;
  return (
    <Ribbon label="Requisition actions">
      <RibbonGroup caption="Manage">
        {props.onSave !== undefined || props.saveHint ? <RibbonButton busy={props.saving} disabled={!props.onSave} hint={props.saveHint} icon={SaveIcon} label="Save" onClick={() => props.onSave?.()} /> : null}
        <RibbonStack>
          <RibbonButton disabled={busy} label="New" onClick={props.onNew} />
          <RibbonButton disabled={busy || !props.onCopyDocument} hint={props.onCopyDocument ? 'Copy the lines of another requisition into this one.' : 'Lines are copied into a requisition that is still being written.'} label="Copy Document..." onClick={() => props.onCopyDocument?.()} />
          <RibbonButton disabled={busy || !props.onDelete} hint={props.onDelete ? undefined : 'Only its requester deletes a requisition, before it is decided.'} label="Delete" onClick={() => props.onDelete?.()} tone={props.onDelete ? 'danger' : undefined} />
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup caption="Request Approval">
        <RibbonButton busy={busy} disabled={!props.onSendApproval} hint={props.sendHint} icon={SendIcon} label="Send Approval Request" onClick={() => props.onSendApproval?.()} />
        <RibbonButton busy={busy} disabled={!props.onCancelApproval} hint={props.onCancelApproval ? 'Take it back to a draft. Nobody has decided it yet.' : 'Open while it waits for approval, to whoever asked for it.'} icon={XIcon} label="Cancel Approval Request" onClick={() => props.onCancelApproval?.()} />
      </RibbonGroup>

      <RibbonGroup caption="Release">
        <RibbonButton busy={busy} disabled={!props.onRelease} hint={props.releaseHint ?? 'Releasing is approving: an approver releases a requisition that waits for approval.'} icon={FileCheck2Icon} label="Release" onClick={() => props.onRelease?.()} />
        <RibbonButton busy={busy} disabled={!props.onReopen} hint={props.onReopen ? 'Back to its requester to change, and approved again.' : 'An approved requisition with no order yet is reopened.'} icon={RotateCcwIcon} label="Reopen" onClick={() => props.onReopen?.()} />
      </RibbonGroup>

      {props.deciding ? (
        <RibbonGroup caption="Approve">
          <RibbonButton busy={busy} disabled={!props.onRelease} hint={props.releaseHint} icon={CheckIcon} label="Approve" onClick={() => props.onRelease?.()} />
          <RibbonButton busy={busy} disabled={!props.onSendBack} icon={Undo2Icon} label="Send Back" onClick={() => props.onSendBack?.()} />
          <RibbonButton busy={busy} disabled={!props.onReject} icon={BanIcon} label="Reject" onClick={() => props.onReject?.()} tone={props.onReject ? 'danger' : undefined} />
        </RibbonGroup>
      ) : null}

      <RibbonGroup caption="Prepare">
        <RibbonStack>
          <RibbonButton disabled={busy || !props.onAddLow} hint={props.onAddLow ? 'Adds a line for each item of this company that is at or below its reorder level.' : 'Nothing of this company is low, or the requisition is not being written.'} label="Add Everything That Is Low" onClick={() => props.onAddLow?.()} />
          <RibbonButton disabled={busy || !props.onSelectFromCategories} label="Select From Item Categories" onClick={() => props.onSelectFromCategories?.()} />
          <RibbonButton disabled={busy || !props.onScan} label={props.scanning ? 'Stop Scanning' : 'Scan Items'} onClick={() => props.onScan?.()} pressed={props.scanning} />
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup caption="Order">
        <RibbonButton busy={busy} disabled={!props.onMakeOrder} hint={props.orderHint ?? 'A purchaser makes the order once the requisition is approved.'} icon={ShoppingCartIcon} label="Make Purchase Order" onClick={() => props.onMakeOrder?.()} />
      </RibbonGroup>

      <RibbonGroup caption="Print">
        <RibbonButton disabled={!props.onPrint} hint={props.onPrint ? 'The requisition, as it was last saved, as a PDF.' : 'Save it first.'} icon={PrinterIcon} label="Print..." onClick={() => props.onPrint?.()} />
      </RibbonGroup>

      <RibbonGroup caption="Show Attached">
        <RibbonStack>
          <RibbonButton label="Notes" onClick={() => props.onToggle('notes')} pressed={props.shown.notes} />
          <RibbonButton label="Links" onClick={() => props.onToggle('links')} pressed={props.shown.links} />
          <RibbonButton label="Comments" onClick={() => props.onToggle('comments')} pressed={props.shown.comments} />
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup caption="Page">
        <RibbonStack>
          <RibbonButton disabled={!props.onPrevious} label="Previous" onClick={() => props.onPrevious?.()} />
          <RibbonButton disabled={!props.onNext} label="Next" onClick={() => props.onNext?.()} />
          <RibbonButton label="Go to" onClick={props.onGoTo} />
        </RibbonStack>
      </RibbonGroup>
    </Ribbon>
  );
}

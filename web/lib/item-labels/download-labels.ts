import { createElement } from 'react';

import type { LabelPaper, LabelPick } from './label-sheets';

/**
 * Item labels as a PDF, made in the browser on a click (2026-11-19), as a
 * purchase order is: the Item codes tab already holds every code and
 * description it prints. The PDF library loads only when somebody prints.
 */

export const labelsFileName = (paper: LabelPaper, count: number) => `Item labels ${paper === 'SHEET' ? 'sheet' : 'roll'} (${count}).pdf`;

export async function labelsPdf(picks: readonly LabelPick[], paper: LabelPaper, startAt: number): Promise<Blob> {
  const [{ pdf }, { ItemLabelsDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./label-document')]);
  return pdf(createElement(ItemLabelsDocument, { picks, paper, startAt }) as Parameters<typeof pdf>[0]).toBlob();
}

/** Saved under its file name. */
export async function downloadLabels(picks: readonly LabelPick[], paper: LabelPaper, startAt: number) {
  const count = picks.reduce((sum, pick) => sum + pick.copies, 0);
  const url = URL.createObjectURL(await labelsPdf(picks, paper, startAt));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = labelsFileName(paper, count);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // After the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

import { Text, View } from 'react-native';
import { choiceInvitesComment } from '@texasrenters/shared';

import { ChoiceField, CommentField } from '../capture/ChecklistAnswerFields';
import type { ChecklistItem } from '../capture/area-checklist';
import type { ChecklistAssessment } from '../domain/models';

/**
 * The two questions an occupied visit asks about a room, on the review screen.
 *
 * ── WHY HERE, WHEN THE C/U/W CHECKLIST WAS DELIBERATELY REMOVED FROM IT ──────
 *
 * Those are different questions with different authors, and the distinction is
 * the reason this is not a reversal of that decision. Clean / undamaged /
 * working are three judgements *about evidence*, and the office scores them
 * during review because the reviewer is the one reading the recording. The
 * occupied pair is a judgement about the room itself, made by the person
 * standing in it — the office asked for exactly one answer per room, and only
 * the technician can give it.
 *
 * Until now the only way to reach them was a control inside the camera's guide
 * sheet: `AreaChecklistSheet` is imported by the camera screen and nowhere
 * else. On the one visit type built around photographs rather than filming, a
 * technician who photographed a room and backed out never saw them, so the
 * office got no condition data at all for that area.
 *
 * ── INLINE RATHER THAN BEHIND A BUTTON ───────────────────────────────────────
 *
 * A button opening a sheet would reproduce the bug in a smaller form: still one
 * more thing to know to tap, on a visit whose whole brief is speed. Two
 * questions fit on the screen they belong to. A sixty-item HVAC form would not,
 * which is why this is scoped to the occupied pair rather than made general.
 */
export function OccupiedConditionCard({
  items,
  assessments,
  onRecord,
}: {
  items: readonly ChecklistItem[];
  /** Current answers, keyed by checklist item id. */
  assessments: Map<string, ChecklistAssessment>;
  /**
   * Records one field. The caller re-sends the whole assessment — the API takes
   * a complete record, so a patch sent alone would clear everything else.
   */
  onRecord: (
    itemId: string,
    patch: { textValue?: string | null; comment?: string | null },
  ) => void;
}) {
  // Nothing to ask is not an error. An occupied inspection created before the
  // organization-wide rows existed has no items, and an empty bordered card
  // saying "Condition" would read as something that failed to load.
  if (!items.length) return null;

  return (
    <View className="mx-5 mt-4 rounded-xl border border-border bg-card p-4">
      <Text className="text-base font-bold text-foreground">Condition</Text>
      <Text className="mt-1 text-sm leading-5 text-muted-foreground">
        How the room presented itself. Optional — anything that needs fixing belongs in a finding.
      </Text>
      {items.map((item) => {
        const current = assessments.get(item.id);
        const answer = current?.textValue ?? null;
        return (
          <View className="mt-4" key={item.id}>
            <Text className="text-sm font-semibold text-foreground">{item.label}</Text>
            <ChoiceField
              item={item}
              onChange={(next) => onRecord(item.id, { textValue: next })}
              value={answer}
            />
            {/* Asked only when the answer says something was wrong — prompted
                rather than required, for the reasons in `choiceInvitesComment`. */}
            {choiceInvitesComment(answer) ? (
              <CommentField
                item={item}
                onChange={(next) => onRecord(item.id, { comment: next })}
                value={current?.comment ?? null}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

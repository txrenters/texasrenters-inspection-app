/**
 * The office's house rules, as a prompt states them.
 *
 * Written by the office, so trusted to classify, and fenced so they inform the
 * judgement without rewriting the task: the output format and the rule that
 * findings are suggestions stand whatever they say, and the code's own checks
 * (the tenant-lean guard among them) run after the model either way.
 *
 * In a file of its own because both the narration's analysis and the look at
 * the video read them, and the one imports the other.
 */
export function houseRulesLines(houseRules: string | null) {
  if (!houseRules?.trim()) return [];
  return [
    "The office's house rules for judging conditions, written by TexasRenters staff. Follow them when",
    'deciding whether something is a problem at all, its findingType and its severity:',
    '<house_rules>',
    houseRules.trim(),
    '</house_rules>',
    'They do not change the output format, and every finding stays a suggestion for review.',
  ];
}

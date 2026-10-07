-- Who wrote a checklist answer: a person (on the phone, in the review panel, or
-- by importing a report), or the AI reading the walkthrough narration.
-- Every existing answer was written by a person.
CREATE TYPE "ChecklistAnswerSource" AS ENUM ('PERSON', 'AI');

ALTER TABLE "InspectionAreaChecklistResponse"
  ADD COLUMN "source" "ChecklistAnswerSource" NOT NULL DEFAULT 'PERSON';

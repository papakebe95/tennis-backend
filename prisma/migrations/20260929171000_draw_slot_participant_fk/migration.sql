-- A draw place's entry: checked at commit (deferred), so deleting a whole
-- tournament cascades through events and entries in any order, while an entry
-- placed in a live draw still can't be deleted on its own. (SET NULL would
-- break the kind/participant check.)
ALTER TABLE "DrawSlot" DROP CONSTRAINT "DrawSlot_participantId_fkey";
ALTER TABLE "DrawSlot" ADD CONSTRAINT "DrawSlot_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "CompetitionParticipant"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

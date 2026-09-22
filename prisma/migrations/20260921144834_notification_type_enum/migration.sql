-- Notification.type was free text; the app only knows these five kinds.
-- Hand-edited from the generated drop/add so existing rows are kept: known
-- values are cast in place, anything unexpected becomes SYSTEM.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BOOKING', 'TOURNAMENT', 'MATCH', 'MARKETPLACE', 'SYSTEM');

-- AlterTable
ALTER TABLE "Notification"
  ALTER COLUMN "type" TYPE "NotificationType"
  USING (
    CASE upper("type")
      WHEN 'BOOKING' THEN 'BOOKING'
      WHEN 'TOURNAMENT' THEN 'TOURNAMENT'
      WHEN 'MATCH' THEN 'MATCH'
      WHEN 'MARKETPLACE' THEN 'MARKETPLACE'
      ELSE 'SYSTEM'
    END
  )::"NotificationType";

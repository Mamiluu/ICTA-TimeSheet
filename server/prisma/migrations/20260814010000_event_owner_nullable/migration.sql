-- Event.ownerId was RESTRICT, which meant an admin who ever owned an event
-- could never be hard-deleted (see superadminRouter DELETE /admins/:id).
-- That guard is being deliberately relaxed: an admin can now be fully
-- deleted even if they own events. The event rows are not touched or
-- removed -- only ownerId goes to NULL. The public attendance flow
-- (public.js) looks events up by slug, never by owner, so signing in on an
-- existing event link keeps working. What's lost is admin-side visibility:
-- admin.js filters the event list strictly by ownerId === current admin,
-- so an ownerless event stops appearing in anyone's dashboard after this.

ALTER TABLE "Event" ALTER COLUMN "ownerId" DROP NOT NULL;

ALTER TABLE "Event" DROP CONSTRAINT "Event_ownerId_fkey";
ALTER TABLE "Event" ADD CONSTRAINT "Event_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

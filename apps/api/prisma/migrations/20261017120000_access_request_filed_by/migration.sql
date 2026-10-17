-- AccessRequest.filedById (#1645): who filed a request on the requester's behalf. Nullable, no backfill:
-- every existing row reads null, which means the requester filed it themselves.
ALTER TABLE "access_requests" ADD COLUMN "filedById" UUID;

ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_filedById_fkey" FOREIGN KEY ("filedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

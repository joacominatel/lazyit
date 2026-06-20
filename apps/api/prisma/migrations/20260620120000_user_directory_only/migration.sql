-- ADR-0069 REDESIGN §3.3: a directory-only person is a User without a login (created by the bulk
-- import for an asset's "assigned to"). `directoryOnly` is a NOT NULL boolean defaulting to false so
-- every existing/normal User is unaffected; `directoryAttrs` is optional jsonb (cargo/department/phone
-- and any person sub-field with no native home), populated only on directory rows.
ALTER TABLE "users"
  ADD COLUMN "directoryOnly" boolean NOT NULL DEFAULT false,
  ADD COLUMN "directoryAttrs" jsonb;

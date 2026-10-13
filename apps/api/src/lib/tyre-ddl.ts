// Tyre extension tables — provisioned into every tenant schema by provisionTenantSchema()
// (see provision-schema.ts).
//
// Conventions (same as the transport_* / hotel_* tables in the sibling repos):
//   • camelCase quoted column names, UUID PKs, branchId on every row
//   • every statement starts with CREATE TABLE IF NOT EXISTS / ALTER TABLE /
//     CREATE [UNIQUE] INDEX IF NOT EXISTS so runDDL can schema-qualify it
//   • idempotent — safe to re-run on already-provisioned tenants
//   • accessed with raw SQL ($queryRawUnsafe) — intentionally NOT in schema.prisma

export const TYRE_DDL: string[] = [
  // ── Customer vehicles ───────────────────────────────────────────────────────
  // One row per registration number. Powers "last fitted / next due" reminders and the
  // vehicle's tyre history on the counter.
  `CREATE TABLE IF NOT EXISTS "tyre_vehicles" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"         UUID        NOT NULL,
  "regNo"            TEXT        NOT NULL,
  "partyId"          UUID,
  "vehicleType"      TEXT        NOT NULL DEFAULT 'car',
  "makeModel"        TEXT,
  "tyreSize"         TEXT,
  "ownerName"        TEXT,
  "ownerPhone"       TEXT,
  "lastServiceDate"  DATE,
  "lastOdometer"     INTEGER,
  "nextServiceDate"  DATE,
  "nextServiceKm"    INTEGER,
  "remindersOff"     BOOLEAN     NOT NULL DEFAULT false,
  "notes"            TEXT,
  "isActive"         BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("branchId", "regNo")
)`,

  // ── Warranty register ───────────────────────────────────────────────────────
  // One row per tyre unit sold with a serial number or a warranty period. Created by the
  // sale endpoint, so a claim is a lookup by serial / DOT / vehicle / phone.
  `CREATE TABLE IF NOT EXISTS "tyre_warranty" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"       UUID        NOT NULL,
  "invoiceId"      UUID        NOT NULL,
  "invoiceNo"      TEXT,
  "productId"      UUID,
  "itemName"       TEXT        NOT NULL,
  "itemKind"       TEXT        NOT NULL DEFAULT 'tyre',
  "brand"          TEXT,
  "size"           TEXT,
  "serialNo"       TEXT,
  "dotCode"        TEXT,
  "position"       TEXT,
  "partyId"        UUID,
  "customerName"   TEXT,
  "customerPhone"  TEXT,
  "vehicleNo"      TEXT,
  "soldOn"         DATE        NOT NULL DEFAULT CURRENT_DATE,
  "warrantyMonths" INTEGER     NOT NULL DEFAULT 0,
  "warrantyUntil"  DATE,
  "status"         TEXT        NOT NULL DEFAULT 'active'
                                 CHECK ("status" IN ('active','claimed','void')),
  "claimedAt"      TIMESTAMPTZ,
  "claimOutcome"   TEXT        CHECK ("claimOutcome" IN ('replaced','prorata','repaired','rejected')),
  "claimNotes"     TEXT,
  "claimAmount"    NUMERIC(12,2),
  "createdBy"      UUID,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  // A serial number can only be live once per product: re-keying the same tyre is refused,
  // while a voided row (returned / bill cancelled) frees the serial again.
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_twarr_serial" ON "tyre_warranty" ("branchId", "productId", UPPER("serialNo")) WHERE "serialNo" IS NOT NULL AND "status" <> 'void'`,
  `CREATE INDEX IF NOT EXISTS "idx_twarr_invoice" ON "tyre_warranty" ("invoiceId")`,
  `CREATE INDEX IF NOT EXISTS "idx_twarr_vehicle" ON "tyre_warranty" ("branchId", "vehicleNo")`,
  `CREATE INDEX IF NOT EXISTS "idx_twarr_until"   ON "tyre_warranty" ("branchId", "warrantyUntil")`,
  `CREATE INDEX IF NOT EXISTS "idx_tveh_due"      ON "tyre_vehicles" ("branchId", "nextServiceDate")`,

  // ── Outbound WhatsApp messages ──────────────────────────────────────────────
  // One row per message, so staff can see what was sent / failed and retry.
  `CREATE TABLE IF NOT EXISTS "tyre_notifications" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"       UUID        NOT NULL,
  "kind"           TEXT        NOT NULL,
  "refType"        TEXT,
  "refId"          UUID,
  "recipientName"  TEXT,
  "toPhone"        TEXT        NOT NULL,
  "message"        TEXT        NOT NULL,
  "attachment"     TEXT,
  "dedupeKey"      TEXT,
  "status"         TEXT        NOT NULL DEFAULT 'queued'
                                 CHECK ("status" IN ('queued','sent','failed','skipped')),
  "error"          TEXT,
  "attempts"       INTEGER     NOT NULL DEFAULT 0,
  "createdBy"      UUID,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sentAt"         TIMESTAMPTZ
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tnotif_dedupe" ON "tyre_notifications" ("branchId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "idx_tnotif_ref" ON "tyre_notifications" ("refType", "refId")`,
]

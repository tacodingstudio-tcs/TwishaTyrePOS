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

  // What the next check is for ("Wheel alignment", "Wheel balancing", …) — shown on reminders.
  `ALTER TABLE "tyre_vehicles" ADD COLUMN IF NOT EXISTS "nextServiceFor" TEXT`,

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
  // Stock = SUM over the ledger: a covering index turns every balance lookup into an index-only scan.
  `CREATE INDEX IF NOT EXISTS "idx_sl_balance" ON "stock_ledger" ("branchId", "productId") INCLUDE ("qty", "txnType", "createdAt")`,
  // "Who owes me" only ever looks at open bills; keep them in a tiny index however many paid bills pile up.
  `CREATE INDEX IF NOT EXISTS "idx_inv_open" ON "invoices" ("branchId", "txnType", "partyId") WHERE "status" IN ('confirmed','partial')`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_branch_type_date" ON "invoices" ("branchId", "txnType", "date" DESC)`,
  `CREATE INDEX IF NOT EXISTS "idx_tnotif_ref" ON "tyre_notifications" ("refType", "refId")`,

  // ── Team: people, daily marks, advances / bonus / salary ────────────────────
  // Separate from login users: a fitter or helper needs no login to be on the payroll.
  `CREATE TABLE IF NOT EXISTS "tyre_staff" (
  "id"          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"    UUID          NOT NULL,
  "name"        TEXT          NOT NULL,
  "phone"       TEXT,
  "designation" TEXT,
  "joinDate"    DATE,
  "salaryType"  TEXT          NOT NULL DEFAULT 'monthly' CHECK ("salaryType" IN ('monthly','daily')),
  "baseSalary"  NUMERIC(12,2) NOT NULL DEFAULT 0,
  "weeklyOff"   INTEGER       NOT NULL DEFAULT 0,
  "userId"      UUID,
  "isActive"    BOOLEAN       NOT NULL DEFAULT true,
  "notes"       TEXT,
  "createdAt"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS "tyre_staff_days" (
  "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"      UUID         NOT NULL,
  "staffId"       UUID         NOT NULL,
  "date"          DATE         NOT NULL,
  "status"        TEXT         NOT NULL CHECK ("status" IN ('present','half','absent','leave')),
  "overtimeHours" NUMERIC(4,1) NOT NULL DEFAULT 0,
  "note"          TEXT,
  "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE ("staffId", "date")
)`,
  `CREATE TABLE IF NOT EXISTS "tyre_staff_ledger" (
  "id"        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"  UUID          NOT NULL,
  "staffId"   UUID          NOT NULL,
  "kind"      TEXT          NOT NULL CHECK ("kind" IN ('advance','bonus','deduction','recovery','salary')),
  "amount"    NUMERIC(12,2) NOT NULL CHECK ("amount" > 0),
  "date"      DATE          NOT NULL,
  "month"     TEXT          NOT NULL,
  "method"    TEXT          NOT NULL DEFAULT 'cash',
  "note"      TEXT,
  "expenseId" UUID,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS "idx_tsdays_month"  ON "tyre_staff_days" ("branchId", "date")`,
  `CREATE INDEX IF NOT EXISTS "idx_tsled_staff"   ON "tyre_staff_ledger" ("staffId", "month")`,
]

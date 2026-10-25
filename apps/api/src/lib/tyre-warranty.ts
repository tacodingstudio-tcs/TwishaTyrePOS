// Warranty claims: record, follow up with the tyre company, issue a replacement from stock, correct, and edit details.
//
// Every step runs in one database transaction on the locked warranty row, so two taps at once cannot both win, a
// replacement can never leave stock without a warranty record (or the reverse), and a refused step changes nothing.
//
// Claim life: active → claimed. A claim is either decided at once (replaced / prorata / repaired / rejected) or sent to
// the tyre company ("pending") and decided later by updating it. A replacement tyre handed over from stock is taken out
// of the ledger and gets its own warranty row (same end date as the tyre it replaces), linked both ways.

import type { FastifyRequest } from 'fastify'
import { SERIALISED_KINDS } from '@billing/domain-registry'
import { tbl, httpError, todayStr, ymd } from './tyre-helpers.js'
import { WARRANTY_CLAIM_DDL } from './tyre-ddl.js'

type Req = FastifyRequest
export type Outcome = 'pending' | 'replaced' | 'prorata' | 'repaired' | 'rejected'

export interface Replacement { productId: string; serialNo?: string | null; dotCode?: string | null }
export interface ClaimInput {
  outcome: Outcome
  notes: string
  claimAmount?: number | null
  claimRef?: string | null
  replacement?: Replacement
}
export type ClaimPatch = Partial<Omit<ClaimInput, 'replacement'>> & { replacement?: Replacement }
export interface DetailsPatch {
  customerName?: string | null
  customerPhone?: string | null
  vehicleNo?: string | null
  serialNo?: string | null
  dotCode?: string | null
  position?: string | null
}

const SEL = (S: string) => `SELECT w.*, to_char(w."warrantyUntil", 'YYYY-MM-DD') AS "untilYmd", to_char(w."claimedAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "claimedYmd"
   FROM ${tbl(S, 'tyre_warranty')} w WHERE w.id = $1::uuid AND w."branchId" = $2::uuid FOR UPDATE`

/** A unique-index clash on the serial number becomes a plain 409; anything else (including our own 4xx) passes through. */
function mapClash(err: unknown, serial?: string | null): never {
  if (/uq_twarr_serial|duplicate key|23505/i.test(String((err as any)?.message ?? ''))) {
    throw httpError(409, `Serial number ${serial ? `${serial} ` : ''}is already registered for this tyre`)
  }
  throw err
}

const change = (req: Req, kind: string, extra: Record<string, unknown>) => JSON.stringify([{ at: new Date().toISOString(), by: req.userId, kind, ...extra }])

async function issueReplacement(tx: any, req: Req, orig: any, r: Replacement) {
  const S = req.schemaName
  const prod = (await tx.$queryRawUnsafe(
    `SELECT id, name, "domainAttrs", "itemType", "trackStock", "isActive", COALESCE("purchasePrice", 0)::float AS cost
       FROM ${tbl(S, 'products')} WHERE id = $1::uuid AND "branchId" = $2::uuid FOR UPDATE`, r.productId, req.branchId) as any[])[0]
  if (!prod || !prod.isActive) throw httpError(404, 'The replacement tyre is not in the catalogue')
  const kind = prod.domainAttrs?.item_kind ?? 'tyre'
  if (prod.itemType === 'service' || !(SERIALISED_KINDS as readonly string[]).includes(kind)) throw httpError(422, 'Pick a tyre (not a service) as the replacement')
  if (prod.trackStock) {
    const stock = Number((await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(qty), 0)::float AS s FROM ${tbl(S, 'stock_ledger')} WHERE "branchId" = $1::uuid AND "productId" = $2::uuid`, req.branchId, r.productId) as any[])[0]?.s ?? 0)
    if (stock < 1) throw httpError(409, `${prod.name}: none in stock to give as a replacement`)
    await tx.$executeRawUnsafe(
      `INSERT INTO ${tbl(S, 'stock_ledger')} ("id","branchId","productId","txnType",qty,rate,"refType","refId",notes,"createdBy","createdAt")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'adjustment', -1, $3, 'warranty_replacement', $4::uuid, $5, $6::uuid, NOW())`,
      req.branchId, r.productId, prod.cost, orig.id, `Warranty replacement for ${orig.serialNo ?? orig.itemName} (bill ${orig.invoiceNo ?? ''})`, req.userId)
  }
  const a = prod.domainAttrs ?? {}
  const created = (await tx.$queryRawUnsafe(
    `INSERT INTO ${tbl(S, 'tyre_warranty')}
       ("branchId","invoiceId","invoiceNo","productId","itemName","itemKind","brand","size","serialNo","dotCode",
        "partyId","customerName","customerPhone","vehicleNo","soldOn","warrantyMonths","warrantyUntil","replacesId","createdBy")
     VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::uuid,$12,$13,$14,$15::date,$16,$17::date,$18::uuid,$19::uuid)
     RETURNING *`,
    req.branchId, orig.invoiceId, orig.invoiceNo, r.productId, prod.name, kind, a.brand ?? orig.brand ?? null, a.size ?? orig.size ?? null,
    r.serialNo?.trim() || null, r.dotCode ?? null, orig.partyId ?? null, orig.customerName ?? null, orig.customerPhone ?? null, orig.vehicleNo ?? null,
    todayStr(), orig.warrantyMonths ?? 0, orig.untilYmd ?? null, orig.id, req.userId) as any[])[0]
  await tx.$executeRawUnsafe(`UPDATE ${tbl(S, 'tyre_warranty')} SET "replacementId" = $1::uuid, "updatedAt" = NOW() WHERE id = $2::uuid`, created.id, orig.id)
  return created
}


// ── Make sure a shop's warranty table has the claim columns ─────────────────────────────────────────────────────
// New columns are normally added by `pnpm provision:all`; a shop that was never re-provisioned after a deploy would
// otherwise fail on its first claim. Checked once per shop per process, then it costs nothing.
const checked = new Set<string>()
export async function ensureWarrantySchema(req: Req): Promise<void> {
  const S = req.schemaName
  if (checked.has(S)) return
  const have = await req.db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tyre_warranty' AND column_name = 'claimHistory'`, S)
  if (!(have[0]?.n)) {
    for (const stmt of WARRANTY_CLAIM_DDL) await req.db.$executeRawUnsafe(stmt.replace(/^ALTER TABLE "tyre_warranty"/, `ALTER TABLE "${S}"."tyre_warranty"`))
  }
  checked.add(S)
}

export async function recordClaim(req: Req, id: string, input: ClaimInput) {
  const S = req.schemaName
  await ensureWarrantySchema(req)
  try {
    return await req.db.$transaction(async (tx) => {
      const w = ((await tx.$queryRawUnsafe(SEL(S), id, req.branchId)) as any[])[0]
      if (!w) throw httpError(404, 'Warranty record not found')
      if (w.status === 'void') throw httpError(422, 'This record was voided (bill cancelled or tyre returned)')
      if (w.status === 'claimed') throw httpError(409, 'A claim has already been recorded on this tyre')
      if (w.untilYmd && w.untilYmd < todayStr() && input.outcome !== 'rejected') {
        throw httpError(422, `Warranty ended on ${w.untilYmd} — record the claim as "rejected", or void and re-issue if you are honouring it`)
      }
      if (input.replacement && input.outcome !== 'replaced') throw httpError(422, 'A replacement tyre goes with the outcome "Replaced"')
      const settled = input.outcome !== 'pending'
      const row = ((await tx.$queryRawUnsafe(
        `UPDATE ${tbl(S, 'tyre_warranty')}
            SET status = 'claimed', "claimedAt" = NOW(), "claimOutcome" = $3, "claimNotes" = $4, "claimAmount" = $5, "claimRef" = $6,
                "claimSettledAt" = ${settled ? 'NOW()' : 'NULL'}, "claimHistory" = "claimHistory" || $7::jsonb, "updatedAt" = NOW()
          WHERE id = $1::uuid AND "branchId" = $2::uuid RETURNING *`,
        id, req.branchId, input.outcome, input.notes, input.claimAmount ?? null, input.claimRef?.trim() || null,
        change(req, 'claim', { outcome: input.outcome, notes: input.notes, claimAmount: input.claimAmount ?? null, claimRef: input.claimRef ?? null }))) as any[])[0]
      const replacement = input.replacement ? await issueReplacement(tx, req, w, input.replacement) : null
      const warnings: string[] = []
      if (input.outcome === 'replaced' && !replacement) warnings.push('No replacement tyre was recorded, so stock was not changed — update the claim when you hand one over')
      return { ...row, replacement, warnings }
    }, { timeout: 20_000 })
  } catch (e) { return mapClash(e, input.replacement?.serialNo) }
}

export async function updateClaim(req: Req, id: string, patch: ClaimPatch) {
  const S = req.schemaName
  await ensureWarrantySchema(req)
  try {
    return await req.db.$transaction(async (tx) => {
      const w = ((await tx.$queryRawUnsafe(SEL(S), id, req.branchId)) as any[])[0]
      if (!w) throw httpError(404, 'Warranty record not found')
      if (w.status !== 'claimed') throw httpError(409, w.status === 'void' ? 'This record was voided' : 'No claim has been recorded on this tyre yet')
      const outcome = (patch.outcome ?? w.claimOutcome) as Outcome
      if (w.replacementId && outcome !== 'replaced') throw httpError(422, 'A replacement tyre was already handed over — void that replacement first if the claim was a mistake')
      if (patch.replacement && outcome !== 'replaced') throw httpError(422, 'A replacement tyre goes with the outcome "Replaced"')
      if (patch.replacement && w.replacementId) throw httpError(409, 'A replacement was already issued for this claim')
      if (w.untilYmd && w.untilYmd < (w.claimedYmd ?? todayStr()) && outcome !== 'rejected') {
        throw httpError(422, `Warranty ended on ${w.untilYmd}, before the claim was made — it can only be recorded as "rejected"`)
      }
      const notes = patch.notes ?? w.claimNotes
      const amount = patch.claimAmount === undefined ? (w.claimAmount == null ? null : Number(w.claimAmount)) : patch.claimAmount
      const ref = patch.claimRef === undefined ? w.claimRef : (patch.claimRef?.trim() || null)
      const settleNow = w.claimOutcome === 'pending' && outcome !== 'pending'
      const unsettle = w.claimOutcome !== 'pending' && outcome === 'pending'
      const row = ((await tx.$queryRawUnsafe(
        `UPDATE ${tbl(S, 'tyre_warranty')}
            SET "claimOutcome" = $3, "claimNotes" = $4, "claimAmount" = $5, "claimRef" = $6,
                "claimSettledAt" = ${settleNow ? 'NOW()' : unsettle ? 'NULL' : '"claimSettledAt"'},
                "claimHistory" = "claimHistory" || $7::jsonb, "updatedAt" = NOW()
          WHERE id = $1::uuid AND "branchId" = $2::uuid RETURNING *`,
        id, req.branchId, outcome, notes, amount, ref,
        change(req, 'update', {
          before: { outcome: w.claimOutcome, notes: w.claimNotes, claimAmount: w.claimAmount == null ? null : Number(w.claimAmount), claimRef: w.claimRef },
          after: { outcome, notes, claimAmount: amount, claimRef: ref },
        }))) as any[])[0]
      const replacement = patch.replacement ? await issueReplacement(tx, req, w, patch.replacement) : null
      return { ...row, replacement, warnings: [] as string[] }
    }, { timeout: 20_000 })
  } catch (e) { return mapClash(e, patch.replacement?.serialNo) }
}

export async function editWarrantyDetails(req: Req, id: string, patch: DetailsPatch) {
  const S = req.schemaName
  await ensureWarrantySchema(req)
  try {
    return await req.db.$transaction(async (tx) => {
      const w = ((await tx.$queryRawUnsafe(SEL(S), id, req.branchId)) as any[])[0]
      if (!w) throw httpError(404, 'Warranty record not found')
      if (w.status === 'void') throw httpError(422, 'A voided record cannot be edited')
      const fields = ['customerName', 'customerPhone', 'vehicleNo', 'serialNo', 'dotCode', 'position'] as const
      const sets: string[] = []; const params: unknown[] = [id, req.branchId]
      const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {}
      for (const f of fields) {
        if (patch[f] === undefined || patch[f] === w[f]) continue
        params.push(patch[f]); sets.push(`"${f}" = $${params.length}`)
        before[f] = w[f]; after[f] = patch[f]
      }
      if (sets.length === 0) return { ...w, warnings: [] as string[] }
      params.push(change(req, 'edit', { before, after }))
      const row = ((await tx.$queryRawUnsafe(
        `UPDATE ${tbl(S, 'tyre_warranty')} SET ${sets.join(', ')}, "claimHistory" = "claimHistory" || $${params.length}::jsonb, "updatedAt" = NOW()
          WHERE id = $1::uuid AND "branchId" = $2::uuid RETURNING *`, ...params)) as any[])[0]
      return { ...row, warnings: [] as string[] }
    }, { timeout: 20_000 })
  } catch (e) { return mapClash(e, patch.serialNo) }
}

export { ymd }

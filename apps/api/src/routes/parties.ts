// apps/api/src/routes/parties.ts

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  createParty,
  listParties,
  getPartyStatement,
  CreatePartySchema,
  UpdatePartySchema,
} from '../services/party.service.js'
import { normalizeMobile } from '../lib/validators.js'
import { isValidGstin } from '../lib/gstin.js'
import { requireManager } from '../lib/tyre-helpers.js'

const ImportRow = z.object({
  name:    z.string().trim().min(1).max(200),
  type:    z.string().trim().max(20).optional(),
  phone:   z.string().trim().max(30).optional(),
  email:   z.string().trim().max(120).optional(),
  gstin:   z.string().trim().max(20).optional(),
  address: z.string().trim().max(300).optional(),
  city:    z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(10).optional(),
})
const ImportBody = z.object({
  rows:   z.array(z.object({}).passthrough()).min(1).max(2000),
  dryRun: z.boolean().default(false),
})

export const partyRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/parties
  app.get('/', async (req) => {
    const query = z.object({
      type:    z.string().optional(),
      search:  z.string().optional(),
      hasDebt: z.coerce.boolean().optional(),
      page:    z.coerce.number().default(1),
      limit:   z.coerce.number().default(20),
    }).parse(req.query)

    return listParties(
      { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role },
      query
    )
  })

  // POST /api/parties/import { rows, dryRun } — customers / suppliers from an Excel or CSV sheet (owner / manager).
  // A row needs only a name. A bad mobile / GSTIN / email is left out and reported as a warning, never a lost row;
  // a mobile already on file (or twice in the sheet) is skipped.
  app.post('/import', async (req) => {
    requireManager(req)
    const body = ImportBody.parse(req.body)
    const ctx = { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role }
    const seen = new Set<string>()
    const out = { created: 0, skipped: [] as Array<{ row: number; name: string; why: string }>,
      warnings: [] as Array<{ row: number; name: string; why: string }>, problems: [] as Array<{ row: number; name: string; why: string }> }
    for (const [i, raw] of body.rows.entries()) {
      const rowNo = i + 1
      const parsed = ImportRow.safeParse(raw)
      const name = String((raw as any)?.name ?? '').slice(0, 60)
      if (!parsed.success) { out.problems.push({ row: rowNo, name, why: parsed.error.issues[0]?.message ?? 'Invalid row' }); continue }
      const r = parsed.data
      const warn = (why: string) => out.warnings.push({ row: rowNo, name: r.name, why })
      let phone: string | undefined
      if (r.phone) {
        const ph = normalizeMobile(r.phone)
        if (/^[6-9]\d{9}$/.test(ph)) phone = ph
        else warn(`mobile "${r.phone}" is not a 10-digit mobile — left blank`)
      }
      let gstin: string | undefined
      if (r.gstin) {
        const g = r.gstin.toUpperCase()
        if (isValidGstin(g)) gstin = g; else warn(`GSTIN "${r.gstin}" is not valid — left blank`)
      }
      let email: string | undefined
      if (r.email) { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) email = r.email.toLowerCase(); else warn(`email "${r.email}" is not valid — left blank`) }
      let pincode: string | undefined
      if (r.pincode) { if (/^[1-9]\d{5}$/.test(r.pincode)) pincode = r.pincode; else warn(`pincode "${r.pincode}" is not valid — left blank`) }
      const t = (r.type ?? '').toLowerCase()
      const type = /supplier|vendor|purchase/.test(t) ? 'supplier' : /both/.test(t) ? 'both' : 'customer'
      try {
        if (phone) {
          if (seen.has(phone)) { out.skipped.push({ row: rowNo, name: r.name, why: 'mobile appears twice in this file' }); continue }
          seen.add(phone)
          const dup = await req.db.party.findFirst({ where: { phone }, select: { name: true } })
          if (dup) { out.skipped.push({ row: rowNo, name: r.name, why: `mobile already registered to "${dup.name}"` }); continue }
        } else {
          const key = `n:${r.name.toLowerCase()}`
          const dup = seen.has(key) || await req.db.party.findFirst({ where: { name: { equals: r.name, mode: 'insensitive' }, phone: null }, select: { id: true } })
          seen.add(key)
          if (dup) { out.skipped.push({ row: rowNo, name: r.name, why: 'same name without a mobile already exists' }); continue }
        }
        if (!body.dryRun) {
          const address = (r.address || r.city || pincode) ? { ...(r.address && { line1: r.address }), ...(r.city && { city: r.city }), ...(pincode && { pincode }) } : undefined
          await createParty(CreatePartySchema.parse({ type, name: r.name, phone, email, gstin, address, creditLimit: 0, meta: {} }), ctx)
        }
        out.created++
      } catch (e: any) { out.problems.push({ row: rowNo, name: r.name, why: String(e?.message ?? 'Could not save').slice(0, 160) }) }
    }
    return { dryRun: body.dryRun, ...out }
  })

  // POST /api/parties
  app.post('/', async (req, reply) => {
    const input = CreatePartySchema.parse(req.body)
    const party = await createParty(input, {
      db: req.db, branchId: req.branchId,
      userId: req.userId, role: req.role,
    })
    return reply.status(201).send(party)
  })

  // GET /api/parties/:id — tenant-scoped (accessible from any branch within the same tenant)
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const party   = await req.db.party.findFirst({
      where: { id },
    })
    if (!party) return reply.status(404).send({ error: 'Party not found' })
    return party
  })

  // PATCH /api/parties/:id
  app.patch('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = UpdatePartySchema.parse(req.body)

    const existing = await req.db.party.findFirst({ where: { id, branchId: req.branchId } })
    if (!existing) return reply.status(404).send({ error: 'Party not found' })

    return req.db.party.update({ where: { id }, data: input as Parameters<typeof req.db.party.update>[0]['data'] })
  })

  // GET /api/parties/:id/statement
  app.get('/:id/statement', async (req) => {
    const { id }  = z.object({ id: z.string().uuid() }).parse(req.params)
    const filters = z.object({
      fromDate: z.string().optional(),
      toDate:   z.string().optional(),
    }).parse(req.query)

    return getPartyStatement(id,
      { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role },
      filters
    )
  })

  // GET /api/parties/udhaar/summary
  // Quick udhaar summary — total outstanding for this branch
  app.get('/udhaar/summary', async (req) => {
    const result = await req.db.party.aggregate({
      where:  { branchId: req.branchId, type: { in: ['customer','both'] }, balance: { gt: 0 } },
      _sum:   { balance: true },
      _count: { id: true },
    })

    return {
      totalOutstanding: Number(result._sum.balance ?? 0),
      customerCount:    result._count.id,
    }
  })

  // POST /api/parties/:id/send-statement
  // Generates a WhatsApp share link pre-filled with the outstanding statement.
  // No external API needed — the link opens WhatsApp on the owner's device
  // pointing directly to the customer's chat with the message ready to send.
  app.post('/:id/send-statement', async (req, reply) => {
    const { id }  = z.object({ id: z.string().uuid() }).parse(req.params)
    const body    = z.object({
      // Include only unpaid invoices, or full ledger
      mode:      z.enum(['outstanding_only','full_ledger']).default('outstanding_only'),
      fromDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // Business signature line shown at bottom of message
      signature: z.string().max(100).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const party = await db.party.findFirst({
      where: { id, branchId },
      select: { name: true, phone: true, balance: true },
    })
    if (!party) return reply.status(404).send({ error: 'Party not found' })
    if (!party.phone)
      return reply.status(422).send({ error: 'Party has no phone number — cannot generate WhatsApp link' })

    // Fetch pending invoices for this branch
    const invoices = await db.invoice.findMany({
      where: {
        partyId:  id,
        branchId,
        txnType:  'sale_invoice',
        status:  { in: body.mode === 'outstanding_only'
          ? ['confirmed','partial']
          : ['confirmed','partial','paid'] },
        ...(body.fromDate && { date: { gte: new Date(body.fromDate) } }),
        ...(body.toDate   && { date: { lte: new Date(body.toDate)   } }),
      },
      select: { number: true, date: true, grandTotal: true, paidAmt: true, status: true },
      orderBy: { date: 'asc' },
    })

    const branch = await db.branch.findUnique({
      where: { id: branchId }, select: { name: true },
    })

    const totalOutstanding = Number(party.balance)

    // Build WhatsApp message text
    const lines: string[] = [
      `*${branch?.name ?? 'Our Store'} — Account Statement*`,
      `Customer: *${party.name}*`,
      `Date: ${new Date().toLocaleDateString('en-IN')}`,
      '',
    ]

    if (invoices.length === 0) {
      lines.push('No pending invoices. Your account is clear. 🙏')
    } else {
      lines.push(`*${body.mode === 'outstanding_only' ? 'Pending Invoices' : 'Invoices'}:*`)
      for (const inv of invoices) {
        const balance = Number(inv.grandTotal) - Number(inv.paidAmt)
        const dateStr = new Date(inv.date).toLocaleDateString('en-IN')
        if (body.mode === 'outstanding_only' && balance <= 0) continue
        lines.push(
          `• ${inv.number} (${dateStr}) — ` +
          `₹${Number(inv.grandTotal).toLocaleString('en-IN')}` +
          (balance > 0 ? ` | *Due: ₹${balance.toLocaleString('en-IN')}*` : ' ✓ Paid'),
        )
      }
      lines.push('')
      lines.push(`*Total Outstanding: ₹${totalOutstanding.toLocaleString('en-IN')}*`)
    }

    if (body.signature) {
      lines.push('', body.signature)
    }

    const message = lines.join('\n')

    // Normalize phone: strip +91, spaces, dashes → 10 digits
    const rawPhone  = party.phone.replace(/\D/g, '')
    const phone10   = rawPhone.length === 12 && rawPhone.startsWith('91')
      ? rawPhone.slice(2)
      : rawPhone.length === 11 && rawPhone.startsWith('0')
      ? rawPhone.slice(1)
      : rawPhone
    const waPhone   = `91${phone10}`  // WhatsApp needs country code without +
    const waLink    = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`

    return reply.send({
      partyName:   party.name,
      phone:       party.phone,
      outstanding: totalOutstanding,
      invoiceCount: invoices.length,
      message,
      whatsapp_link: waLink,
    })
  })
}

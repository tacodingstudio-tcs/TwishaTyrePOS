// apps/api/src/routes/users.ts
//
// User management within a tenant — create staff, set branch access,
// update roles, reset PINs, deactivate.
//
// Role hierarchy enforced here:
//   owner   → can do everything
//   manager → can read users; cannot create/modify other managers or the owner
//   cashier/viewer → cannot access user management at all
//
//  GET    /api/users          list users (owner/manager)
//  GET    /api/users/me       current user's own profile
//  POST   /api/users          create staff user (owner only)
//  GET    /api/users/:id      single user (owner/manager)
//  PATCH  /api/users/:id      update name / role / branchIds / lang (owner only)
//  POST   /api/users/:id/reset-pin    reset PIN (owner only)
//  POST   /api/users/:id/deactivate   deactivate user (owner only)
//  POST   /api/users/:id/activate     reactivate user (owner only)

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { mobile, optionalEmail } from '../lib/validators.js'
import { hashPin, verifyPin } from '../lib/password.js'
import { revokeAllUserTokens } from '../lib/refreshToken.service.js'
import { db as publicDb } from '@billing/db'
import { throttleKey, lockedMinutes, clearLoginAttempts, checkLoginThrottle, recordFailedAttempt } from '../lib/login-throttle.js'

const ROLES = ['owner', 'manager', 'cashier', 'viewer'] as const

export const userRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /me — own profile ─────────────────────────────────────────────────
  // Available to all authenticated users.
  app.get('/me', async (req, reply) => {
    const user = await req.db.user.findUnique({
      where:  { id: req.userId },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
      },
    })
    if (!user) return reply.status(404).send({ error: 'User not found' })
    return user
  })

  // ── POST /me/change-pin — change your own PIN ────────────────────────────────────────────────────────────
  // Any signed-in user; needs the current PIN. A wrong current PIN counts like a wrong sign-in (the same 5-tries lock), so this
  // box cannot be used to guess the PIN. (422, not 401: a 401 would make the screen think the session has ended.)
  app.post('/me/change-pin', async (req, reply) => {
    const body = z.object({
      currentPin: z.string().regex(/^\d{4}$/, 'The current PIN is 4 digits'),
      newPin:     z.string().regex(/^\d{4}$/, 'The new PIN must be 4 digits'),
    }).parse(req.body)
    if (body.currentPin === body.newPin) return reply.status(422).send({ error: 'The new PIN is the same as the current one' })

    const me = await req.db.user.findUnique({ where: { id: req.userId }, select: { id: true, pin: true, phone: true } })
    if (!me) return reply.status(404).send({ error: 'User not found' })
    const t = await publicDb.tenant.findUnique({ where: { id: req.tenantId }, select: { ownerPhone: true } })
    const key = throttleKey(t?.ownerPhone ?? '', me.phone)
    const gate = await checkLoginThrottle(key)
    if (!gate.allowed) return reply.status(429).send({ error: `Too many wrong PINs. Try again in ${Math.max(1, Math.ceil((gate.retryAfterSec ?? 900) / 60))} minutes.` })
    if (!(await verifyPin(body.currentPin, me.pin ?? ""))) {
      await recordFailedAttempt(key)
      return reply.status(422).send({ error: 'The current PIN is not correct' })
    }
    await clearLoginAttempts(key)
    await req.db.user.update({ where: { id: me.id }, data: { pin: await hashPin(body.newPin) } })
    await revokeAllUserTokens(req.tenantId, me.id)       // other devices / old sessions must sign in with the new PIN
    return reply.send({ success: true, message: 'PIN changed. Use the new PIN the next time you sign in.' })
  })

  // ── GET / — list users ────────────────────────────────────────────────────
  app.get('/', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Manager or owner access required' })

    const q = z.object({
      role:     z.enum(ROLES).optional(),
      isActive: z.coerce.boolean().optional(),
      search:   z.string().optional(),
      page:     z.coerce.number().int().min(1).default(1),
      limit:    z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)

    const skip = (q.page - 1) * q.limit

    const where: Record<string, unknown> = {}
    if (q.role     !== undefined) where['role']     = q.role
    if (q.isActive !== undefined) where['isActive'] = q.isActive
    if (q.search) {
      where['OR'] = [
        { name:  { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
      ]
    }

    const [total, users] = await Promise.all([
      req.db.user.count({ where }),
      req.db.user.findMany({
        where,
        select: {
          id: true, name: true, phone: true, email: true,
          role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
          // pin intentionally excluded from list
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: q.limit,
      }),
    ])

    // who is locked out right now (five wrong PINs), so the screen can offer "Unlock"
    const tenant = await publicDb.tenant.findUnique({ where: { id: req.tenantId }, select: { ownerPhone: true } })
    const withLock = await Promise.all(users.map(async (u) => ({
      ...u, lockedMinutes: tenant?.ownerPhone ? await lockedMinutes(throttleKey(tenant.ownerPhone, u.phone)) : 0,
    })))

    return { total, page: q.page, limit: q.limit, users: withLock }
  })

  // ── POST / — create staff user (owner only) ───────────────────────────────
  // The new user can immediately log in with the phone + PIN.
  // `branchIds: []` means the user has access to all branches.
  app.post('/', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can create users' })
    if (process.env['SINGLE_USER'] === 'true')
      return reply.status(403).send({ error: 'This installation has a single login — extra users cannot be added' })

    const body = z.object({
      name:      z.string().min(2).max(100).trim(),
      phone:     mobile,
      email:     optionalEmail,
      pin:       z.string().length(4).regex(/^\d{4}$/, 'PIN must be 4 digits'),
      role:      z.enum(['manager', 'cashier', 'viewer']).default('cashier'),
      branchIds: z.array(z.string().uuid()).default([]),
      lang:      z.enum(['hi', 'en', 'gu', 'mr', 'ta', 'te', 'kn', 'bn']).default('hi'),
    }).parse(req.body)

    const db = req.db

    // Validate that all specified branchIds actually exist
    if (body.branchIds.length > 0) {
      const existing = await db.branch.findMany({
        where:  { id: { in: body.branchIds } },
        select: { id: true },
      })
      if (existing.length !== body.branchIds.length) {
        const found    = new Set(existing.map((b) => b.id))
        const missing  = body.branchIds.filter((id) => !found.has(id))
        return reply.status(422).send({ error: 'Branch not found', branchIds: missing })
      }
    }

    // Check phone uniqueness within this tenant schema
    const dup = await db.user.findUnique({ where: { phone: body.phone }, select: { id: true } })
    if (dup) return reply.status(409).send({ error: 'A user with this phone already exists' })

    const user = await db.user.create({
      data: {
        name:      body.name,
        phone:     body.phone,
        email:     body.email ?? null,
        role:      body.role,
        branchIds: body.branchIds,
        pin:       await hashPin(body.pin),
        lang:      body.lang,
        isActive:  true,
      },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
      },
    })

    return reply.status(201).send(user)
  })

  // ── GET /:id — single user ────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Manager or owner access required' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const user = await req.db.user.findUnique({
      where:  { id },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
      },
    })
    if (!user) return reply.status(404).send({ error: 'User not found' })
    return user
  })

  // ── PATCH /:id — update user ──────────────────────────────────────────────
  // Owner can update anyone. Managers cannot be updated by other managers.
  app.patch('/:id', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can update users' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      name:      z.string().min(2).max(100).trim().optional(),
      email:     z.string().email().optional().nullable(),
      role:      z.enum(['manager', 'cashier', 'viewer']).optional(),
      branchIds: z.array(z.string().uuid()).optional(),
      lang:      z.enum(['hi', 'en', 'gu', 'mr', 'ta', 'te', 'kn', 'bn']).optional(),
    }).parse(req.body)

    const db = req.db

    const existing = await db.user.findUnique({ where: { id }, select: { role: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })

    // Cannot demote or reassign the owner account
    if (existing.role === 'owner')
      return reply.status(409).send({ error: 'The owner account role cannot be changed via this endpoint' })

    // Validate branchIds if provided
    if (body.branchIds && body.branchIds.length > 0) {
      const found = await db.branch.findMany({
        where:  { id: { in: body.branchIds } },
        select: { id: true },
      })
      if (found.length !== body.branchIds.length) {
        const foundIds = new Set(found.map((b) => b.id))
        return reply.status(422).send({ error: 'Branch not found', branchIds: body.branchIds.filter((id) => !foundIds.has(id)) })
      }
    }

    return db.user.update({
      where: { id },
      data: {
        ...(body.name      !== undefined && { name:      body.name }),
        ...(body.email     !== undefined && { email:     body.email }),
        ...(body.role      !== undefined && { role:      body.role }),
        ...(body.branchIds !== undefined && { branchIds: body.branchIds }),
        ...(body.lang      !== undefined && { lang:      body.lang }),
      },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true,
      },
    })
  })

  // ── POST /:id/unlock — lift a sign-in lock (owner or manager) ───────────────
  // Five wrong PINs lock an account for 15 minutes. The owner or a manager can lift that at once, so a forgotten PIN
  // at opening time does not stop the shop; a manager can unlock the owner too. The PIN is still needed to sign in.
  app.post('/:id/unlock', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Only the owner or a manager can unlock an account' })
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const user = await req.db.user.findUnique({ where: { id }, select: { id: true, phone: true, role: true } })
    if (!user) return reply.status(404).send({ error: 'User not found' })
    const tenant = await publicDb.tenant.findUnique({ where: { id: req.tenantId }, select: { ownerPhone: true } })
    if (!tenant?.ownerPhone) return reply.status(404).send({ error: 'Business not found' })
    const key = throttleKey(tenant.ownerPhone, user.phone)
    const was = await lockedMinutes(key)
    await clearLoginAttempts(key)
    return reply.send({ success: true, userId: id, wasLocked: was > 0, message: was > 0 ? 'Unlocked — they can sign in now' : 'This account was not locked' })
  })

  // ── POST /:id/reset-pin — change a user's PIN (owner only) ────────────────
  app.post('/:id/reset-pin', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can reset PINs' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { pin } = z.object({
      pin: z.string().length(4).regex(/^\d{4}$/, 'PIN must be 4 digits'),
    }).parse(req.body)

    const db = req.db
    const existing = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })

    await db.user.update({
      where: { id },
      data:  { pin: await hashPin(pin) },
    })

    // Revoke all active refresh tokens for this user so an attacker who held
    // a stolen token is forced to re-authenticate with the new PIN immediately.
    await revokeAllUserTokens(req.tenantId, id)

    // a new PIN also lifts any sign-in lock (the person was probably locked out by the old one)
    const t = await publicDb.tenant.findUnique({ where: { id: req.tenantId }, select: { ownerPhone: true } })
    const u = await db.user.findUnique({ where: { id }, select: { phone: true } })
    if (t?.ownerPhone && u) await clearLoginAttempts(throttleKey(t.ownerPhone, u.phone))

    return reply.send({ success: true, userId: id, message: 'PIN updated successfully' })
  })

  // ── POST /:id/deactivate ──────────────────────────────────────────────────
  app.post('/:id/deactivate', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can deactivate users' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    const existing = await db.user.findUnique({ where: { id }, select: { role: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })
    if (existing.role === 'owner')
      return reply.status(409).send({ error: 'Cannot deactivate the owner account' })
    if (id === req.userId)
      return reply.status(409).send({ error: 'Cannot deactivate your own account' })

    await db.user.update({ where: { id }, data: { isActive: false } })
    // Revoke all active refresh tokens immediately so the deactivated user
    // cannot continue to get new access tokens after the current one expires.
    await revokeAllUserTokens(req.tenantId, id)
    return reply.send({ success: true, userId: id })
  })

  // ── POST /:id/activate ────────────────────────────────────────────────────
  app.post('/:id/activate', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can activate users' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    const existing = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })

    await db.user.update({ where: { id }, data: { isActive: true } })
    return reply.send({ success: true, userId: id })
  })
}

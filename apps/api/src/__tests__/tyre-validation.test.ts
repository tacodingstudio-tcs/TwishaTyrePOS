// Field validation on every form that takes a mobile number, GSTIN, PAN, pincode, HSN, email or PIN.
// Rule of thumb under test: blank is fine for optional boxes; anything typed must be valid, with a plain message.

import { newShopTenant, testPhone, type Session } from './helpers'

const GSTIN = (() => {              // a GSTIN with a correct check digit
  const base = '24AABCR1234A1Z'; const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let sum = 0; for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(m / 36) + (m % 36) }
  return base + CH[(36 - (sum % 36)) % 36]
})()
const BAD_MOBILES = ['123', '12345678901', '5876543210', '98765 4321', 'abcdefghij', '+91 12345 67890']

describe('Field validation', () => {
  let owner: Session
  const msg = (r: any) => JSON.stringify(r.data)
  beforeAll(async () => { owner = await newShopTenant('Validation Tyres') })

  describe('mobile numbers', () => {
    test('customers (parties) refuse anything that is not a 10-digit mobile; prefixes are tidied', async () => {
      for (const phone of BAD_MOBILES) {
        const r = await owner.api.post('/api/parties', { type: 'customer', name: 'Bad Mobile', phone })
        expect(r.status).toBe(422)
        expect(msg(r)).toMatch(/10-digit mobile/)
      }
      const ok = await owner.api.post('/api/parties', { type: 'customer', name: 'Good Mobile', phone: '+91 98765-43210' })
      expect(ok.status).toBe(201)
      expect(ok.data.phone).toBe('9876543210')
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'No Mobile' })).status).toBe(201)
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'Blank Mobile', phone: '' })).status).toBe(201)
    })

    test('suppliers', async () => {
      expect((await owner.api.post('/api/inventory/suppliers', { name: 'Bad Supplier', phone: '12345' })).status).toBe(422)
      const ok = await owner.api.post('/api/inventory/suppliers', { name: 'Good Supplier', phone: '09876500001' })
      expect(ok.status).toBe(201)
      expect(ok.data.phone).toBe('9876500001')
      expect((await owner.api.patch(`/api/inventory/suppliers/${ok.data.id}`, { phone: '99' })).status).toBe(422)
    })

    test('staff on the team page', async () => {
      expect((await owner.api.post('/api/tyre/team/staff', { name: 'Bad Phone', phone: '1234567', baseSalary: 1000 })).status).toBe(422)
      expect((await owner.api.post('/api/tyre/team/staff', { name: 'Good Phone', phone: '9811100077', baseSalary: 1000 })).status).toBe(201)
      expect((await owner.api.post('/api/tyre/team/staff', { name: 'No Phone Staff', baseSalary: 1000 })).status).toBe(201)
    })

    test('vehicle owner', async () => {
      expect((await owner.api.post('/api/tyre/vehicles', { regNo: 'GJ05AB1234', ownerName: 'X', ownerPhone: '12345' })).status).toBe(422)
      expect((await owner.api.post('/api/tyre/vehicles', { regNo: 'GJ05AB1234', ownerName: 'X', ownerPhone: '9811100078' })).status).toBe(201)
    })

    test('shop users (staff logins) and the owner alert number', async () => {
      expect((await owner.api.post('/api/users', { name: 'Bad Login', phone: '12345', pin: '1234', role: 'cashier' })).status).toBe(422)
      expect((await owner.api.post('/api/users', { name: 'Good Login', phone: testPhone(), pin: '1234', role: 'cashier' })).status).toBe(201)
      expect((await owner.api.put('/api/tyre/notify-settings', { notify_owner_phone: '123' })).status).toBe(422)
      expect((await owner.api.put('/api/tyre/notify-settings', { notify_owner_phone: '9811100079' })).status).toBe(200)
      expect((await owner.api.put('/api/tyre/notify-settings', { notify_owner_phone: null })).status).toBe(200)
    })

    test('registering a new shop', async () => {
      const r = await owner.api.post('/api/tenants/register', { businessName: 'Bad Phone Shop', ownerName: 'Owner', phone: '12345', pin: '1234', domainType: 'tyre' })
      expect([400, 422]).toContain(r.status)
    })
  })

  describe('PIN', () => {
    test('exactly four digits when creating a login or resetting', async () => {
      for (const pin of ['123', '12345', 'abcd', '12 4']) {
        expect((await owner.api.post('/api/users', { name: 'Pin Test', phone: testPhone(), pin, role: 'cashier' })).status).toBe(422)
      }
    })
  })

  describe('GSTIN, PAN, pincode, email', () => {
    test('customer GSTIN: blank ok, wrong refused, right accepted', async () => {
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'G Blank', gstin: '' })).status).toBe(201)
      const bad = await owner.api.post('/api/parties', { type: 'customer', name: 'G Bad', gstin: '24AABCR1234A1Z0'.replace(/.$/, GSTIN.endsWith('0') ? '1' : '0') })
      expect(bad.status).toBe(422)
      expect(msg(bad)).toMatch(/GSTIN is not valid/)
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'G Short', gstin: '24AABC' })).status).toBe(422)
      const ok = await owner.api.post('/api/parties', { type: 'customer', name: 'G Good', gstin: GSTIN.toLowerCase() })
      expect(ok.status).toBe(201)
      expect(ok.data.gstin).toBe(GSTIN)
    })

    test('supplier GSTIN and PAN', async () => {
      expect((await owner.api.post('/api/inventory/suppliers', { name: 'S Bad', gstin: '123' })).status).toBe(422)
      expect((await owner.api.post('/api/inventory/suppliers', { name: 'S Bad Pan', pan: 'ABC123' })).status).toBe(422)
      const ok = await owner.api.post('/api/inventory/suppliers', { name: 'S Good', gstin: GSTIN, pan: 'aabcr1234a' })
      expect(ok.status).toBe(201)
      expect(ok.data.pan).toBe('AABCR1234A')
    })

    test('party address pincode and email', async () => {
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'Pin Bad', address: { pincode: '12345' } })).status).toBe(422)
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'Pin Good', address: { pincode: '362720' } })).status).toBe(201)
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'Mail Bad', email: 'not-an-email' })).status).toBe(422)
      expect((await owner.api.post('/api/parties', { type: 'customer', name: 'Mail Good', email: 'Shop@Example.com' })).status).toBe(201)
    })

    test('the shop’s own GSTIN in settings', async () => {
      const id = (await owner.api.get('/api/branches')).data[0].id
      expect((await owner.api.patch(`/api/branches/${id}`, { gstin: '24AABCR1234A1Z9' })).status).toBe(422)
      expect((await owner.api.patch(`/api/branches/${id}`, { gstin: GSTIN })).status).toBe(200)
    })
  })

  describe('HSN', () => {
    const mk = (hsnSacCode: unknown) => owner.api.post('/api/products', {
      itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: `Tyre ${Math.random()}`, salePrice: 5000, hsnSacCode,
      domainAttrs: { item_kind: 'tyre', brand: 'MRF', size: '185/65 R15', vehicle_type: 'car' },
    })
    test('4 to 8 digits only; blank means “fill it in for me”', async () => {
      for (const bad of ['123', 'ABCD', '123456789', '40 11']) expect((await mk(bad)).status).toBe(422)
      expect((await mk('401110')).data.hsnSacCode).toBe('401110')
      expect((await mk('')).data.hsnSacCode).toBe('401110')            // auto-filled for a car tyre
    })
  })
})

describe('Tyre size on the product', () => {
  let owner: Session
  const mk = (size: unknown, extra: Record<string, unknown> = {}) => owner.api.post('/api/products', {
    itemType: 'product', gstRate: 18, unit: 'pcs', trackStock: true, name: `Tyre ${Math.random()}`, salePrice: 5000, openingStock: 2,
    domainAttrs: { item_kind: 'tyre', brand: 'MRF', vehicle_type: 'car', size, ...extra },
  })
  beforeAll(async () => { owner = await newShopTenant('Size Tyres') })

  test('every way a size is really written is accepted', async () => {
    for (const s of ['185/65 R15', '185/65R15', '185 65 15', '1856515', '295/80 R22.5', '90/90-17', '10.00 R20', '7.50-16', '2.75/18', '205/55 ZR16']) {
      const r = await mk(s)
      expect([s, r.status]).toEqual([s, 201])
    }
  })

  test('a typo is refused with a clear message instead of becoming a tyre nobody can find', async () => {
    for (const s of ['185/65 R5', 'abc', '185', 'R15', '185/65 R99', '12345678']) {
      const r = await mk(s)
      expect([s, r.status]).toEqual([s, 422])
      expect(JSON.stringify(r.data)).toMatch(/not recognised/)
    }
  })

  test('only tyres need a size: tubes, scrap and services are left alone; a size is not forced on an edit that does not touch it', async () => {
    expect((await mk('whatever', { item_kind: 'tube' })).status).toBe(201)
    expect((await mk(undefined, { item_kind: 'scrap' })).status).toBe(201)
    const t = (await mk('185/65 R15')).data
    expect((await owner.api.patch(`/api/products/${t.id}`, { salePrice: 5200 })).status).toBe(200)
    expect((await owner.api.patch(`/api/products/${t.id}`, { domainAttrs: { size: '195/60 R16' } })).status).toBe(200)
    expect((await owner.api.patch(`/api/products/${t.id}`, { domainAttrs: { size: '195/60 R6' } })).status).toBe(422)
  })

  test('the size list for quick-pick shows one chip per size, however it was spelt', async () => {
    await mk('155/70R13'); await mk('155/70 R13'); await mk('155 70 13')
    const sizes = (await owner.api.get('/api/tyre/sizes')).data as Array<{ size: string; models: number }>
    const k = sizes.filter((s) => /155\/?70/.test(s.size) || s.size.replace(/\D/g, '') === '1557013')
    expect(k).toHaveLength(1)
    expect(k[0]!.models).toBe(3)
  })
})

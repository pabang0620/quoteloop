import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEED_SKUS } from '../supplier/catalog.js'
import { priceOption, upsellQty } from '../supplier/pricing.js'
import { bpsOf, discountBy, fmt, toCents } from '../shared/money.js'

const hot = SEED_SKUS.find((s) => s.sku === 'CUP-12-HOT')

test('money rounding reproduces the cents in the plan', () => {
  assert.equal(discountBy(12800, 200), 12544)
  assert.equal(bpsOf(25088, 200), 502)
  assert.equal(discountBy(11800, 200), 11564)
  assert.equal(bpsOf(34692, 200), 694)
  assert.equal(toCents('125.44'), 12544)
  assert.equal(fmt(24586), '$245.86')
})

test('mandate A numbers: round 2, 2 cases, pay-now = $245.86, net $122.93 per case', () => {
  const o = priceOption(hot, { qty: 2, round: 2, payNow: true, availableCases: 18 })
  assert.equal(o.unit_cents, 12544)
  assert.equal(o.subtotal_cents, 25088)
  assert.equal(o.pay_now_discount_cents, 502)
  assert.equal(o.total_cents, 24586)
  assert.equal(o.net_unit_cents, 12293)
  assert.equal(o.terms, 'DUE_ON_RECEIPT')
})

test('mandate B numbers: round 2, 3 cases, pay-now = $339.98, net $113.33 per case', () => {
  const o = priceOption(hot, { qty: 3, round: 2, payNow: true, availableCases: 18 })
  assert.equal(o.unit_cents, 11564)
  assert.equal(o.subtotal_cents, 34692)
  assert.equal(o.pay_now_discount_cents, 694)
  assert.equal(o.total_cents, 33998)
  assert.equal(o.net_unit_cents, 11333)
})

test('round 1 options: a = 2 x $128.00 NET_30 ($256.00, score $96), b = 3 x $118.00 ($354.00, score $114)', () => {
  const a = priceOption(hot, { qty: 2, round: 1, payNow: false, availableCases: 18 })
  const b = priceOption(hot, { qty: 3, round: 1, payNow: false, availableCases: 18 })
  assert.deepEqual([a.total_cents, a.terms, a.score_cents], [25600, 'NET_30', 9600])
  assert.deepEqual([b.total_cents, b.terms, b.score_cents], [35400, 'NET_30', 11400])
  assert.equal(upsellQty(hot, 2, 18), 3)
  assert.equal(upsellQty(hot, 2, 2), null)
})

test('no option is ever priced below the floor, whatever the round or the lever', () => {
  for (const sku of SEED_SKUS) {
    for (const qty of [1, 2, 3, 5]) {
      for (const round of [1, 2, 3, 4, 9]) {
        for (const payNow of [false, true]) {
          const o = priceOption(sku, { qty, round, payNow, availableCases: 50 })
          assert.ok(o.total_cents >= sku.floor_cents * qty, `${sku.sku} q${qty} r${round} pn${payNow}: ${o.total_cents}`)
        }
      }
    }
  }
})

test('floor clamp: a squeezed item gives back the pay-now discount first', () => {
  const tight = { ...hot, floor_cents: 11700 }
  const o = priceOption(tight, { qty: 3, round: 3, payNow: true, availableCases: 18 })
  assert.ok(o.total_cents >= 11700 * 3)
  assert.equal(o.floor_clamped, true)
})

test('concession schedule: 0% / 2% / 3%, and never more than the schedule', () => {
  const pcts = [1, 2, 3, 4, 6].map((r) => priceOption(hot, { qty: 2, round: r, payNow: false, availableCases: 18 }).concession_bps)
  assert.deepEqual(pcts, [0, 200, 300, 300, 300])
})

test('stock at or under twice the safety stock gives no concession', () => {
  assert.equal(priceOption(hot, { qty: 2, round: 2, payNow: false, availableCases: 12 }).concession_bps, 0)
  assert.equal(priceOption(hot, { qty: 2, round: 2, payNow: false, availableCases: 13 }).concession_bps, 200)
})

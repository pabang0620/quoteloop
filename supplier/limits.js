// Judge-period guards: a day's live sandbox charges are limited per client and in total, and the shared
// judge sandbox account must keep a minimum balance. Past a limit the same flow runs on simulated PayPal calls.
const dayKey = (now) => new Date(now).toISOString().slice(0, 10)

export function createLimits({ db, config, clock = () => Date.now() }) {
  const j = config.judge
  const balanceDoc = () => db.get('judge', 'balance') || { estimate_cents: j.startingBalanceCents, updated_at: null }

  function usage() {
    return db.get('limits', dayKey(clock())) || { total: 0, per_client: {} }
  }

  // Decide the rail for a new settlement and count it when it is a live sandbox charge.
  // A visitor key can be swapped by whoever controls the browser, so the network address (sent by the buyer
  // service, which sees the request) is counted too, with a wider cap because judges may share an office address.
  function decideRail({ clientKey, networkKey, paypalMode, accountKind, amountCents }) {
    if (paypalMode === 'mock') return { rail: 'mock', reason: null }
    return db.tx(() => {
      const u = usage()
      if (accountKind === 'judge') {
        if (u.total >= j.perDay) return { rail: 'simulated', reason: 'daily_total' }
        if ((u.per_client[clientKey] || 0) >= j.perClientPerDay) return { rail: 'simulated', reason: 'client_daily' }
        if (networkKey && (u.per_client[networkKey] || 0) >= j.perClientPerDay * 3) return { rail: 'simulated', reason: 'client_daily' }
        if (balanceDoc().estimate_cents - amountCents < j.minBalanceCents) return { rail: 'simulated', reason: 'low_balance' }
      }
      const per = { ...u.per_client, [clientKey]: (u.per_client[clientKey] || 0) + 1 }
      if (networkKey) per[networkKey] = (per[networkKey] || 0) + 1
      db.put('limits', dayKey(clock()), { total: u.total + 1, per_client: per })
      return { rail: 'live', reason: null }
    })
  }

  const adjustBalance = (deltaCents) => db.tx(() => {
    const b = balanceDoc()
    db.put('judge', 'balance', { estimate_cents: b.estimate_cents + deltaCents, updated_at: new Date(clock()).toISOString() })
  })
  const setBalance = (cents) => db.put('judge', 'balance', { estimate_cents: cents, updated_at: new Date(clock()).toISOString() })

  function status(clientKey) {
    const u = usage()
    const b = balanceDoc().estimate_cents
    return {
      day: dayKey(clock()),
      used_today: u.total,
      daily_cap: j.perDay,
      client_used: u.per_client[clientKey] || 0,
      client_cap: j.perClientPerDay,
      judge_balance_cents: b,
      judge_min_balance_cents: j.minBalanceCents,
      low_balance: b < j.minBalanceCents,
    }
  }

  return { decideRail, adjustBalance, setBalance, status, balance: () => balanceDoc().estimate_cents }
}

export const SIMULATION_NOTICE = 'Live sandbox runs used for today, resets at 00:00 UTC. You are now seeing the same flow with simulated PayPal calls.'
export const LOW_BALANCE_NOTICE = 'The shared judge sandbox account is being topped up. You are seeing the same flow with simulated PayPal calls.'

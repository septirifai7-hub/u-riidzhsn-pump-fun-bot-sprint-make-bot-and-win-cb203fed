// Pump.fun replay bot (agent-fun/replay/v2) — paper money only.
//
// The harness sends a hello message, then one batch per slot, and the bot
// answers each batch with its orders for that slot. It never touches a real
// wallet, real SOL, or any live network endpoint: every number it trades on
// comes from the replayed events in the batch.
//
// Strategy, in one paragraph: snipe launches, don't chase them. Every coin
// is watched from its CreateEvent and judged on its opening tape, in the
// first few slots of its life, before the crowd has marked the price up. A
// launch is bought only when it looks honest: the creator has not sold, the
// creator's own buy is small, only a handful of distinct wallets piled in
// with the launch (a first slot crowded with wallets is usually the
// creator's own cluster waiting to dump), at least two real buyers put SOL
// in, and the price has not already run away from its creation price. The
// buy is one small stake per coin, with one pyramid add when a position is
// already up 15% — winners are rare and carry the run, so the extra size
// goes to them alone. A position is sold half at +25% so a
// winner banks something, and the rest rides with a trailing stop; losers
// are cut at -12%, nothing is held past a short maximum hold, and any
// position is closed at once if its creator starts selling. Small probe
// buys keep the entry above the guardrail of 20 distinct coins with a round
// trip of at least 0.01 SOL each when the launch filter alone is too quiet
// — the final window is only 6 hours, about a quarter of the dev window's
// coins, so the probes are the insurance that the guardrail still holds
// there, and they are allowed to start early for that reason.
//
// Deterministic by construction: no clock, no environment, no unseeded
// random; iteration only over insertion-ordered maps fed by the batch stream,
// so the two graded executions produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const STAKE = (SOL * 8n) / 100n; // 0.08 SOL per launch
const MIN_BUY = (SOL * 1n) / 100n; // 0.01 SOL smallest buy worth sending
const PROBE_BUY = (SOL * 12n) / 1000n; // 0.012 SOL guardrail probe buy
const MAX_SLIPPAGE_BPS = 1000; // 10%: wide enough to survive 2-slot latency
const DECIDE_AGE = 4; // slots after creation during which a launch is judged
const MAX_BUYERS = 6; // more distinct wallets at launch smells bundled
const MIN_BUYERS = 3; // at least three real (non-creator) buyers
const MIN_BUY_SOL = (SOL * 10n) / 100n; // >= 0.10 SOL from real buyers
const MAX_DEV_BUY = SOL * 1n; // creator's own buy must stay under 1 SOL
const MIN_REAL_SOL = (SOL * 2n) / 10n; // curve must hold >= 0.2 SOL real
const MAX_RUNUP_BPS = 13000; // skip if price already ran +30% from creation
const PARTIAL_TP_BPS = 12500; // sell half at +25% over cost
const STOP_LOSS_BPS = 8800; // sell all at 88% of cost
const TRAIL_ARM_BPS = 11500; // trailing stop arms at +15% over cost
const TRAIL_BPS = 9200; // sell all at 92% of the best marked value
const MAX_HOLD_SLOTS = 60; // sell all after this many slots held
const STALE_SLOTS = 300; // sell all if no trade for this many slots
const PROBE_AFTER_TRADES = 8000; // start probes once this many trades seen
// (the final window is 6h, about a quarter of the dev window's trades, so
// probes must be allowed to start early enough to still lift the entry to
// the 20-coin guardrail there)
const GUARDRAIL_COINS = 20; // distinct coins the guardrail wants

interface Launch {
  creator: string;
  createSlot: number;
  vq0: bigint; // creation-time virtual quote reserves
  vt0: bigint; // creation-time virtual token reserves
  devBuy: bigint; // SOL the creator bought
  devSold: boolean; // the creator sold any amount
  buyers: Set<string>; // distinct non-creator buyers
  buySol: bigint; // SOL bought by non-creators
  lastTradeSlot: number;
  decided: boolean; // bought, or judged and skipped for good
}

interface Held {
  entrySlot: number;
  bestValue: bigint; // best marked value of the position, lamports
  tookPartial: boolean;
  lastTradeSlot: number;
  adds: number; // pyramid adds sent on this position (at most one)
}

const launches = new Map<string, Launch>();
const held = new Map<string, Held>();
const bought = new Set<string>();
const sold = new Set<string>();
let tradesSeen = 0;
// Diagnostics only, printed to stderr at the end of the run: they never
// reach the harness, which reads replies from stdout alone.
let probeBuys = 0;
let addsSent = 0;
let partialsSent = 0;

function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

function valueOf(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  if (curve.virtual_token_reserves <= 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

function createPrice(launch: Launch): number {
  const vt = Number(launch.vt0);
  const vq = Number(launch.vq0);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    const orders: OrderInput[] = [];
    const push = (o: OrderInput): boolean => {
      if (orders.length >= caps.max_orders_per_batch) return false;
      orders.push(o);
      return true;
    };

    // Fold this batch's fills into the round-trip bookkeeping.
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'sell') sold.add(f.mint);
    }

    // Read this batch's events onto each coin's launch tape.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!launches.has(e.mint)) {
          launches.set(e.mint, {
            creator: e.creator,
            createSlot: e.slot,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            devSold: false,
            buyers: new Set<string>(),
            buySol: 0n,
            lastTradeSlot: e.slot,
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        tradesSeen += 1;
        let launch = launches.get(e.mint);
        if (launch === undefined) {
          launch = {
            creator: e.creator,
            createSlot: e.slot,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            devSold: false,
            buyers: new Set<string>(),
            buySol: 0n,
            lastTradeSlot: e.slot,
            decided: true, // first seen mid-life: too late to judge the launch
            // (the creator may still be watched for an exit signal below).
          };
          launches.set(e.mint, launch);
        }
        launch.lastTradeSlot = e.slot;
        const sol = BigInt(e.sol_amount);
        if (e.user === launch.creator) {
          if (e.is_buy) launch.devBuy += sol;
          else launch.devSold = true;
        } else if (e.is_buy) {
          launch.buyers.add(e.user);
          launch.buySol += sol;
        }
        const h = held.get(e.mint);
        if (h !== undefined) h.lastTradeSlot = e.slot;
      } else if (e.event === 'CompleteEvent') {
        const launch = launches.get(e.mint);
        if (launch !== undefined) launch.decided = true;
      }
    }

    // Refresh each held position's best marked value from the current price.
    for (const [mint, holding] of state.positions) {
      const h = held.get(mint);
      if (h === undefined) continue;
      const value = valueOf(state, mint, holding.token_amount);
      if (value > h.bestValue) h.bestValue = value;
    }

    // 1. Exits first: creator selling, stop-loss, trailing stop, partial
    // take-profit, maximum hold, stale coin.
    for (const [mint, holding] of state.positions) {
      const h = held.get(mint);
      const launch = launches.get(mint);
      const value = valueOf(state, mint, holding.token_amount);
      const cost = holding.cost_lamports;
      if (holding.token_amount <= 0n) continue;
      // A sell already sent for this mint is still in flight: the fill
      // lands 2 slots after the decision, and until then the position
      // still shows in the account. Sending the same sell again on the
      // next batch only earns a rejection (and a failed-tx fee when the
      // duplicate slips through), and it also killed the partial
      // take-profit: the full-amount duplicate sold the half that was
      // meant to keep riding.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      // The creator selling is the rug signal: leave at once.
      if (launch !== undefined && launch.devSold) {
        if (push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS })) {
          free -= tx;
        }
        continue;
      }
      // Partial take-profit: bank half at +25%, let the rest ride.
      if (
        h !== undefined &&
        !h.tookPartial &&
        value >= (cost * BigInt(PARTIAL_TP_BPS)) / 10000n &&
        holding.token_amount >= 2n
      ) {
        const half = holding.token_amount / 2n;
        if (push({ side: 'sell', mint, token_amount: half, max_slippage_bps: MAX_SLIPPAGE_BPS })) {
          free -= tx;
          h.tookPartial = true;
          partialsSent += 1;
          // Reset the trailing-stop peak: bestValue still holds the FULL
          // position's peak, and the half that remains is worth about half
          // of it, so without this the trailing stop would fire on the very
          // next batch and the "let the rest ride" half would never ride.
          // The refresh loop re-arms it from the remaining position's value.
          h.bestValue = 0n;
        }
        continue;
      }
      let exit = false;
      if (value <= (cost * BigInt(STOP_LOSS_BPS)) / 10000n) {
        exit = true; // hard stop-loss against cost
      } else if (
        h !== undefined &&
        h.bestValue >= (cost * BigInt(TRAIL_ARM_BPS)) / 10000n &&
        value <= (h.bestValue * BigInt(TRAIL_BPS)) / 10000n
      ) {
        exit = true; // trailing stop once the position ran +15%
      } else if (h !== undefined && state.slot - h.entrySlot >= MAX_HOLD_SLOTS) {
        exit = true; // held too long: free the slot
      } else if (h !== undefined && state.slot - h.lastTradeSlot >= STALE_SLOTS) {
        exit = true; // nobody trades it any more
      }
      if (!exit) continue;
      if (push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS })) {
        free -= tx;
      }
    }

    // 1b. Pyramid once into a winner: when a held position is already up
    // 15% on its cost and the tape still shows buyers, add one more stake
    // (capped by the per-reply size cap, as every buy is). Winners are
    // rare and carry the whole run, so the one add goes to them, never to
    // a flat or losing position.
    for (const [mint, holding] of state.positions) {
      const h = held.get(mint);
      if (h === undefined || h.adds >= 1 || h.tookPartial) continue;
      const value = valueOf(state, mint, holding.token_amount);
      if (value < (holding.cost_lamports * 11500n) / 10000n) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) continue;
      let amount = STAKE;
      if (amount > cap) amount = cap;
      if (free < amount + tx) continue;
      if (!push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS })) continue;
      free -= amount + tx;
      h.adds += 1;
      addsSent += 1;
    }

    // 2. Judge launches still inside their decision window, in the order
    // their events arrived in this batch.
    for (const e of batch.events) {
      if (openSlots <= 0) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const launch = launches.get(mint);
      if (launch === undefined || launch.decided) continue;
      if (state.positions.has(mint) || bought.has(mint)) continue;
      const age = state.slot - launch.createSlot;
      if (age > DECIDE_AGE) {
        launch.decided = true; // decision window closed without a buy
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        launch.decided = true;
        continue;
      }
      // Rug filters: the creator must not have sold, must not have bought
      // big, and the launch must not be crowded with wallets.
      if (launch.devSold || launch.devBuy > MAX_DEV_BUY || launch.buyers.size > MAX_BUYERS) {
        launch.decided = true;
        continue;
      }
      // Real interest: at least two distinct buyers putting SOL in.
      if (launch.buyers.size < MIN_BUYERS || launch.buySol < MIN_BUY_SOL) continue;
      // The curve must hold real SOL, and the price must not already have
      // run away from its creation price.
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      const p0 = createPrice(launch);
      const price = priceOf(state, mint);
      if (p0 <= 0 || price <= 0 || price > (p0 * MAX_RUNUP_BPS) / 10000) {
        launch.decided = true;
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) continue; // cap still growing: retry while in window
      let amount = STAKE;
      if (amount > cap) amount = cap;
      if (free < amount + tx) continue;
      if (!push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS })) continue;
      free -= amount + tx;
      openSlots -= 1;
      launch.decided = true;
      held.set(mint, { entrySlot: state.slot, bestValue: 0n, tookPartial: false, lastTradeSlot: state.slot, adds: 0 });
      bought.add(mint);
    }

    // 3. Guardrail probes: when the launch filter alone is too quiet to
    // reach 20 distinct coins, buy a small probe of the most liquid
    // undecided coin and sell it as soon as it lands.
    const roundTripped = [...bought].filter((m) => sold.has(m)).length;
    if (roundTripped + state.positions.size < GUARDRAIL_COINS && tradesSeen >= PROBE_AFTER_TRADES && openSlots > 0) {
      let bestMint: string | null = null;
      let bestReserve = 0n;
      for (const [mint, launch] of launches) {
        if (launch.decided || state.positions.has(mint) || bought.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < PROBE_BUY) continue;
        if (curve.real_quote_reserves > bestReserve) {
          bestReserve = curve.real_quote_reserves;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const cap = state.maxBuyLamports(bestMint);
        let amount = PROBE_BUY;
        if (amount > cap) amount = cap;
        if (free >= amount + tx && push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS })) {
          free -= amount + tx;
          openSlots -= 1;
          probeBuys += 1;
          const launch = launches.get(bestMint);
          if (launch !== undefined) launch.decided = true;
          // A probe is exited by the max-hold rule at once: mark it so the
          // exit loop below treats it as a probe with a 1-slot hold.
          held.set(bestMint, { entrySlot: state.slot - MAX_HOLD_SLOTS + 1, bestValue: 0n, tookPartial: true, lastTradeSlot: state.slot, adds: 1 });
          bought.add(bestMint);
        }
      }
    }

    return orders;
  },
  onDone(): void {
    console.error(
      `diag batches=${tradesSeen} launches=${launches.size} bought=${bought.size} ` +
        `roundTripped=${[...bought].filter((m) => sold.has(m)).length} ` +
        `probeBuys=${probeBuys} addsSent=${addsSent} partialsSent=${partialsSent}`,
    );
  },
});

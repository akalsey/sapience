import type { RoutedItem } from "./types.js";

// A daily ceiling on CALIBRATE chatter.
//
// 2026-08-03: 28 proposals reached the user in one day. Every one was learning
// tier, 27 of them priority 5, and 24 were the agent narrating its own stuck
// task back to the user who was sitting there watching it fail. Each thinking
// pass re-described the same unresolved situation in new words — its theory of
// the failure kept evolving ("the skill" -> "use-browser" -> "my inability to
// run the steps I myself propose") — so no similarity threshold catches it.
// Text matching answers "is this the same sentence?"; a running commentary on
// one situation is a different question, and containment matching only got
// that day from 28 down to 15.
//
// So this is a circuit breaker rather than another matcher: whatever novel
// shape the next loop takes, the day's calibrate volume is bounded. It applies
// ONLY to the learning tier, which exists to sample how much initiative the
// user wants in a domain — a few samples a day saturates that. Tiers the user
// can act on are never withheld: an outage still gets through on a day the
// suite spent asking questions.
//
// Mirrors `push.maxPerDay`, which already bounds channel wake-ups the same way
// — and which held at 6 that day while deliveries, having no ceiling, did not.

export interface DailyCount {
  date: string;
  count: number;
}

export function spentToday(state: DailyCount, localDate: string): number {
  return state?.date === localDate ? (state.count ?? 0) : 0;
}

export interface BudgetSplit {
  admitted: RoutedItem[];
  overBudget: RoutedItem[];
}

// Order is preserved: callers have already sorted by tier and priority, so the
// calibrate items that survive are the highest-priority ones of the day.
export function splitByCalibrateBudget(
  items: RoutedItem[],
  state: DailyCount,
  localDate: string,
  maxPerDay: number
): BudgetSplit {
  // Negative means "no ceiling". Zero is a real setting — it turns calibrate
  // delivery off — so it must not fall into the same branch.
  if (maxPerDay < 0) return { admitted: items, overBudget: [] };

  let remaining = Math.max(0, maxPerDay - spentToday(state, localDate));
  const admitted: RoutedItem[] = [];
  const overBudget: RoutedItem[] = [];
  for (const item of items) {
    if (item.tier !== "learning") {
      admitted.push(item);
      continue;
    }
    if (remaining > 0) {
      remaining--;
      admitted.push(item);
    } else {
      overBudget.push(item);
    }
  }
  return { admitted, overBudget };
}

export function noteCalibrateUse(state: DailyCount, localDate: string, used: number): DailyCount {
  return { date: localDate, count: spentToday(state, localDate) + used };
}

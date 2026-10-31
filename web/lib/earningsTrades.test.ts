import { describe, it, expect } from "vitest";
import {
  reviewTrade,
  aggregateStats,
  type EarningsTrade,
  type TradeReview,
} from "./earningsTrades";
import type { DailyBar } from "./earningsMove";

const bar = (time: string, close: number): DailyBar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
});

const bullPut: EarningsTrade = {
  id: "1",
  ticker: "BE",
  kind: "bull_put",
  shortStrike: 125,
  longStrike: 120,
  width: 5,
  credit: 0.68,
  maxLoss: 432,
  contracts: 4,
  entryDate: "2026-07-27",
  entrySpot: 180,
  expiration: "2026-07-31",
  richnessAtEntry: 2.3,
  impliedAtEntry: 24,
};

describe("reviewTrade — bull put", () => {
  it("gana el crédito completo si cierra sobre el short strike", () => {
    const r = reviewTrade(bullPut, [bar("2026-07-27", 180), bar("2026-07-31", 130)]);
    expect(r.outcome).toBe("win");
    expect(r.pnl).toBe(272); // 0.68 * 100 * 4
    expect(r.finalSpot).toBe(130);
    expect(r.breached).toBe(false);
    expect(r.daysHeld).toBe(4);
  });

  it("pérdida máxima si cierra bajo el long strike", () => {
    const r = reviewTrade(bullPut, [bar("2026-07-27", 180), bar("2026-07-31", 118)]);
    expect(r.outcome).toBe("loss");
    expect(r.pnl).toBe(-1728); // (0.68 - 5) * 100 * 4
    expect(r.pnlPct).toBe(-100);
    expect(r.breached).toBe(true);
  });

  it("pérdida parcial entre los strikes", () => {
    const r = reviewTrade(bullPut, [bar("2026-07-31", 124)]);
    // intrínseco 1 → perShare 0.68 - 1 = -0.32 → -128
    expect(r.pnl).toBe(-128);
    expect(r.outcome).toBe("loss");
  });

  it("sigue abierto si aún no vence", () => {
    const r = reviewTrade(bullPut, [bar("2026-07-27", 180), bar("2026-07-28", 181)]);
    expect(r.outcome).toBe("open");
    expect(r.pnl).toBeNull();
  });
});

describe("reviewTrade — bear call", () => {
  const bearCall: EarningsTrade = {
    ...bullPut,
    id: "2",
    kind: "bear_call",
    shortStrike: 200,
    longStrike: 205,
    credit: 0.5,
    maxLoss: 450,
  };
  it("gana si cierra bajo el short call", () => {
    const r = reviewTrade(bearCall, [bar("2026-07-31", 195)]);
    expect(r.outcome).toBe("win");
    expect(r.pnl).toBe(200); // 0.5 * 100 * 4
    expect(r.breached).toBe(false);
  });
  it("pierde si cierra sobre el short call", () => {
    const r = reviewTrade(bearCall, [bar("2026-07-31", 210)]);
    expect(r.outcome).toBe("loss");
    expect(r.breached).toBe(true);
  });
});

describe("aggregateStats", () => {
  const trades: EarningsTrade[] = [
    { ...bullPut, id: "w", richnessAtEntry: 2.5 },
    { ...bullPut, id: "l", richnessAtEntry: 1.2 },
    { ...bullPut, id: "o" },
  ];
  const reviews: TradeReview[] = [
    { id: "w", ticker: "BE", outcome: "win", pnl: 272, pnlPct: 15, finalSpot: 130, breached: false, actualMovePct: 5, daysHeld: 4 },
    { id: "l", ticker: "BE", outcome: "loss", pnl: -1728, pnlPct: -100, finalSpot: 118, breached: true, actualMovePct: 30, daysHeld: 4 },
    { id: "o", ticker: "BE", outcome: "open", pnl: null, pnlPct: null, finalSpot: null, breached: false, actualMovePct: null, daysHeld: null },
  ];

  it("calcula win rate, P&L total y richness ganadores vs perdedores", () => {
    const s = aggregateStats(trades, reviews);
    expect(s.total).toBe(3);
    expect(s.closed).toBe(2);
    expect(s.open).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(50);
    expect(s.totalPnl).toBe(-1456); // 272 - 1728
    expect(s.avgRichnessWin).toBeCloseTo(2.5, 5);
    expect(s.avgRichnessLoss).toBeCloseTo(1.2, 5);
  });
});

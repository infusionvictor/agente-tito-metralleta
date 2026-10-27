import { describe, expect, it } from "vitest";
import {
  computePnl,
  computeStats,
  computeStatsBreakdown,
  createTrade,
  evaluateTrade,
  type PaperTrade,
} from "./paperTrades";

const NOW = new Date("2026-08-05T15:00:00Z");

function baseInput() {
  return {
    ticker: "wulf",
    contractType: "call" as const,
    strike: 20,
    expiration: "2026-09-18",
    direction: "up" as const,
    entryTrigger: 22,
    target: 3,
    stop: 1,
    contracts: 2,
  };
}

describe("createTrade", () => {
  it("arranca pendiente, sin precios, ticker en mayúsculas", () => {
    const t = createTrade(baseInput(), NOW);
    expect(t.status).toBe("pending");
    expect(t.ticker).toBe("WULF");
    expect(t.entryPrice).toBeNull();
    expect(t.source).toBe("manual");
  });
});

describe("computePnl", () => {
  it("multiplica por 100 y por contratos", () => {
    expect(computePnl(1, 3, 2)).toBe(400);
    expect(computePnl(2, 1, 3)).toBe(-300);
  });
});

describe("evaluateTrade — pendiente", () => {
  it("no se activa si el subyacente no cruzó el gatillo", () => {
    const t = createTrade(baseInput(), NOW);
    const next = evaluateTrade(t, { underlyingPrice: 21, optionPrice: 1.5 }, NOW);
    expect(next.status).toBe("pending");
  });

  it("se activa cuando el subyacente cruza el gatillo (direction up)", () => {
    const t = createTrade(baseInput(), NOW);
    const next = evaluateTrade(t, { underlyingPrice: 22.5, optionPrice: 1.4 }, NOW);
    expect(next.status).toBe("active");
    expect(next.entryPrice).toBe(1.4);
    expect(next.peakPrice).toBe(1.4);
    expect(next.triggeredAt).toBe(NOW.toISOString());
  });

  it("direction down cruza hacia abajo", () => {
    const t = createTrade({ ...baseInput(), direction: "down", entryTrigger: 18 }, NOW);
    expect(evaluateTrade(t, { underlyingPrice: 19, optionPrice: 1 }, NOW).status).toBe("pending");
    expect(evaluateTrade(t, { underlyingPrice: 17.9, optionPrice: 1 }, NOW).status).toBe("active");
  });

  it("expira si nunca se activó y ya pasó el vencimiento", () => {
    const t = createTrade(baseInput(), NOW);
    const after = new Date("2026-09-19T00:00:00Z");
    const next = evaluateTrade(t, { underlyingPrice: 21, optionPrice: 1 }, after);
    expect(next.status).toBe("expired");
    expect(next.verdict).toMatch(/nunca cruzó el gatillo/);
  });
});

describe("evaluateTrade — activa", () => {
  function activeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
    const t = createTrade(baseInput(), NOW);
    return { ...t, status: "active", entryPrice: 1, peakPrice: 1, stopPrice: 1, ...overrides };
  }

  it("gana al tocar el objetivo", () => {
    const t = activeTrade();
    const next = evaluateTrade(t, { underlyingPrice: 25, optionPrice: 3.2 }, NOW);
    expect(next.status).toBe("won");
    expect(next.closeReason).toBe("target");
    expect(next.exitPrice).toBe(3.2);
  });

  it("pierde al tocar el stop fijo", () => {
    const t = activeTrade();
    const next = evaluateTrade(t, { underlyingPrice: 21, optionPrice: 0.8 }, NOW);
    expect(next.status).toBe("lost");
    expect(next.closeReason).toBe("stop");
  });

  it("el trailing stop solo aprieta, nunca baja el piso original", () => {
    const t = activeTrade({ trailingStopPct: 20 });
    // sube a 2.0 -> pico 2.0, trailing level = 1.6 (> stop fijo de 1) => stop efectivo 1.6
    const up = evaluateTrade(t, { underlyingPrice: 24, optionPrice: 2.0 }, NOW);
    expect(up.status).toBe("active");
    expect(up.peakPrice).toBe(2.0);
    expect(up.stopPrice).toBeCloseTo(1.6);

    // cae a 1.7: sigue por encima del trailing (1.6) -> sigue activa
    const hold = evaluateTrade(up, { underlyingPrice: 23, optionPrice: 1.7 }, NOW);
    expect(hold.status).toBe("active");

    // cae a 1.5: perfora el trailing (1.6) -> cierra asegurando ganancia (won, no lost)
    const closed = evaluateTrade(hold, { underlyingPrice: 22, optionPrice: 1.5 }, NOW);
    expect(closed.status).toBe("won");
    expect(closed.closeReason).toBe("trailing_stop");
    expect(closed.exitPrice).toBe(1.5);
  });

  it("expira en cartera si vence sin tocar objetivo ni stop", () => {
    const t = activeTrade();
    const after = new Date("2026-09-19T00:00:00Z");
    const next = evaluateTrade(t, { underlyingPrice: 23, optionPrice: 1.3 }, after);
    expect(next.status).toBe("won"); // 1.3 > entrada 1 => P&L positivo
    expect(next.closeReason).toBe("expiration");
  });

  it("trades ya cerrados no cambian", () => {
    const t = activeTrade({ status: "won", exitPrice: 3, closedAt: NOW.toISOString() });
    const next = evaluateTrade(t, { underlyingPrice: 30, optionPrice: 5 }, NOW);
    expect(next).toBe(t);
  });
});

describe("computeStats", () => {
  it("agrega P&L, W-L, win rate y cuentas por estado", () => {
    const trades: PaperTrade[] = [
      { ...createTrade(baseInput(), NOW), status: "won", entryPrice: 1, exitPrice: 3, contracts: 2 },
      { ...createTrade(baseInput(), NOW), status: "lost", entryPrice: 2, exitPrice: 1, contracts: 1 },
      { ...createTrade(baseInput(), NOW), status: "pending" },
      { ...createTrade(baseInput(), NOW), status: "active" },
      { ...createTrade(baseInput(), NOW), status: "expired" },
    ];
    const stats = computeStats(trades);
    expect(stats.netPnl).toBe(400 - 100);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(50);
    expect(stats.pending).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.expired).toBe(1);
  });

  it("win rate es null sin trades cerrados", () => {
    const trades: PaperTrade[] = [{ ...createTrade(baseInput(), NOW), status: "pending" }];
    expect(computeStats(trades).winRate).toBeNull();
  });
});

describe("computeStatsBreakdown", () => {
  it("separa manual de auto, y dentro de auto por vía (intraday/swing)", () => {
    const trades: PaperTrade[] = [
      { ...createTrade(baseInput(), NOW), source: "manual", status: "won", entryPrice: 1, exitPrice: 2, contracts: 1 },
      { ...createTrade(baseInput(), NOW), source: "manual", status: "lost", entryPrice: 1, exitPrice: 0.5, contracts: 1 },
      { ...createTrade({ ...baseInput(), source: "auto", path: "intraday" }, NOW), status: "won", entryPrice: 1, exitPrice: 3, contracts: 1 },
      { ...createTrade({ ...baseInput(), source: "auto", path: "swing" }, NOW), status: "lost", entryPrice: 2, exitPrice: 1, contracts: 1 },
      { ...createTrade({ ...baseInput(), source: "auto", path: "swing" }, NOW), status: "pending" },
    ];
    const b = computeStatsBreakdown(trades);
    expect(b.overall.wins).toBe(2);
    expect(b.overall.losses).toBe(2);
    expect(b.manual.wins).toBe(1);
    expect(b.manual.losses).toBe(1);
    expect(b.auto.wins).toBe(1);
    expect(b.auto.losses).toBe(1);
    expect(b.auto.pending).toBe(1);
    expect(b.autoIntraday.wins).toBe(1);
    expect(b.autoIntraday.losses).toBe(0);
    expect(b.autoSwing.losses).toBe(1);
    expect(b.autoSwing.pending).toBe(1);
  });
});

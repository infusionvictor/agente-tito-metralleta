import { describe, it, expect } from "vitest";
import {
  impliedEarningsMove,
  historicalEarningsMoves,
  earningsRichness,
  atmStraddle,
  atmIv,
  type DailyBar,
} from "./earningsMove";

describe("atmIv", () => {
  it("usa el MÍNIMO de call/put IV del strike más cercano (robusto a IV corrupta)", () => {
    const q = [
      { strike: 100, type: "call" as const, iv: 0.5 },
      { strike: 100, type: "put" as const, iv: 4.8 }, // put con IV basura (stale)
      { strike: 90, type: "call" as const, iv: 0.9 },
    ];
    expect(atmIv(q, 101)).toBeCloseTo(0.5, 5); // min(0.5, 4.8) — no deja que el put infle
  });
  it("guardarraíl: null si no hay strike dentro del ±7% del spot (bug STX)", () => {
    const q = [{ strike: 80, type: "call" as const, iv: 0.9 }]; // 20% off del spot 100
    expect(atmIv(q, 100)).toBeNull();
  });
});

describe("atmStraddle", () => {
  const quotes = [
    { strike: 95, type: "call" as const, price: 6 },
    { strike: 95, type: "put" as const, price: 1 },
    { strike: 100, type: "call" as const, price: 3 },
    { strike: 100, type: "put" as const, price: 3 },
    { strike: 105, type: "call" as const, price: 1 },
    { strike: 105, type: "put" as const, price: 6 },
  ];
  it("elige el strike más cercano al spot con call y put", () => {
    const r = atmStraddle(quotes, 101);
    expect(r).not.toBeNull();
    expect(r!.strike).toBe(100);
    expect(r!.callPrice).toBe(3);
    expect(r!.putPrice).toBe(3);
  });
  it("salta strikes sin ambas patas con precio", () => {
    const r = atmStraddle([{ strike: 100, type: "call", price: 3 }], 100);
    expect(r).toBeNull();
  });
});

describe("impliedEarningsMove", () => {
  it("usa el straddle cuando hay precios de call y put", () => {
    // call 5 + put 5 sobre spot 100 → 10%
    const r = impliedEarningsMove({ spot: 100, callPrice: 5, putPrice: 5 });
    expect(r).not.toBeNull();
    expect(r!.method).toBe("straddle");
    expect(r!.impliedMovePct).toBeCloseTo(10, 5);
  });

  it("cae a IV·√(T) cuando no hay straddle", () => {
    // IV 50%, 36.5 días → 0.5·√(0.1) ≈ 15.81%
    const r = impliedEarningsMove({ spot: 100, atmIv: 0.5, dteDays: 36.5 });
    expect(r!.method).toBe("iv");
    expect(r!.impliedMovePct).toBeCloseTo(0.5 * Math.sqrt(36.5 / 365) * 100, 4);
  });

  it("devuelve null si no hay datos suficientes", () => {
    expect(impliedEarningsMove({ spot: 0 })).toBeNull();
    expect(impliedEarningsMove({ spot: 100 })).toBeNull();
  });
});

// Helper: genera barras diarias con closes dados a partir de una fecha.
function bars(start: string, closes: number[]): DailyBar[] {
  const out: DailyBar[] = [];
  const d = new Date(start + "T00:00:00Z");
  for (const c of closes) {
    const t = d.toISOString().slice(0, 10);
    out.push({ time: t, open: c, high: c, low: c, close: c });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("historicalEarningsMoves", () => {
  it("captura reporte before-open (mismo día)", () => {
    // closes: ...100 (prev), 110 (día del reporte) → +10%
    const b = bars("2026-01-01", [100, 110, 111]);
    const r = historicalEarningsMoves(b, ["2026-01-02"]);
    expect(r.sample).toBe(1);
    expect(r.moves[0]).toBeCloseTo(10, 5);
  });

  it("captura reporte after-close (día siguiente)", () => {
    // reporte el 02 after-close: reacción 03. closes 100,101(día),90(next) → move max = |90-101|/101
    const b = bars("2026-01-01", [100, 101, 90]);
    const r = historicalEarningsMoves(b, ["2026-01-02"]);
    expect(r.moves[0]).toBeCloseTo((11 / 101) * 100, 4);
  });

  it("promedia, mediana y máximo sobre varios earnings", () => {
    // dos eventos con moves conocidos de +10% y +20%
    const b = [
      ...bars("2026-01-01", [100, 110]), // evento 1: +10%
      ...bars("2026-04-01", [100, 120]), // evento 2: +20%
    ];
    const r = historicalEarningsMoves(b, ["2026-01-02", "2026-04-02"]);
    expect(r.sample).toBe(2);
    expect(r.avg).toBeCloseTo(15, 5);
    expect(r.median).toBeCloseTo(15, 5);
    expect(r.max).toBeCloseTo(20, 5);
  });

  it("ignora fechas sin bar previo", () => {
    const b = bars("2026-01-05", [100, 110]);
    const r = historicalEarningsMoves(b, ["2026-01-01"]); // antes de todos los bars
    expect(r.sample).toBe(0);
  });
});

describe("earningsRichness", () => {
  const hist = (avg: number, sample: number) => ({
    avg,
    median: avg,
    max: avg,
    sample,
  });

  it("marca 'rica' cuando el implícito supera el histórico +15%", () => {
    const r = earningsRichness(20, hist(10, 8)); // ratio 2.0
    expect(r.verdict).toBe("rica");
    expect(r.richness).toBeCloseTo(2, 5);
  });

  it("marca 'barata' cuando el implícito es < 85% del histórico", () => {
    const r = earningsRichness(8, hist(10, 8)); // ratio 0.8
    expect(r.verdict).toBe("barata");
  });

  it("marca 'justa' en la banda media", () => {
    const r = earningsRichness(10, hist(10, 8)); // ratio 1.0
    expect(r.verdict).toBe("justa");
  });

  it("marca 'sin_datos' con muestra insuficiente (<4)", () => {
    const r = earningsRichness(20, hist(10, 3));
    expect(r.verdict).toBe("sin_datos");
    expect(r.richness).toBeNull();
  });

  it("marca 'sin_datos' si falta el implícito", () => {
    expect(earningsRichness(null, hist(10, 8)).verdict).toBe("sin_datos");
  });
});

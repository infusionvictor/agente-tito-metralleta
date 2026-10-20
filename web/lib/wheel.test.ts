import { describe, expect, it } from "vitest";
import {
  HAIRCUT,
  MIN_OI,
  WHEEL_PRESETS,
  liquidityBlock,
  pickPremium,
  spreadPctOf,
  wheelMetrics,
} from "./wheel";

describe("WHEEL_PRESETS", () => {
  it("los tres presets van de menos a más delta", () => {
    expect(WHEEL_PRESETS.conservador.deltaMax).toBeLessThanOrEqual(WHEEL_PRESETS.balanceado.deltaMin);
    expect(WHEEL_PRESETS.balanceado.deltaMax).toBeLessThanOrEqual(WHEEL_PRESETS.agresivo.deltaMin);
  });

  it("todos cierran al 50% de la prima", () => {
    for (const p of Object.values(WHEEL_PRESETS)) expect(p.takeProfitPct).toBe(50);
  });
});

describe("pickPremium", () => {
  it("prefiere el bid real y no le aplica recorte", () => {
    const pick = pickPremium({ bid: 0.32, ask: 0.36, lastTrade: 0.5, model: 0.6 });
    expect(pick).toEqual({ price: 0.32, source: "bid", raw: 0.32 });
  });

  it("cae al último precio con recorte del 10% cuando no hay bid", () => {
    const pick = pickPremium({ bid: 0, ask: 0.36, lastTrade: 0.5, model: 0.6 });
    expect(pick?.source).toBe("ultimo");
    expect(pick?.price).toBeCloseTo(0.5 * (1 - HAIRCUT.ultimo), 10);
    expect(pick?.raw).toBe(0.5);
  });

  it("cae al modelo con recorte del 15% cuando no hay bid ni último", () => {
    const pick = pickPremium({ model: 0.6 });
    expect(pick?.source).toBe("modelo");
    expect(pick?.price).toBeCloseTo(0.6 * (1 - HAIRCUT.modelo), 10);
  });

  it("devuelve null si no hay ninguna fuente", () => {
    expect(pickPremium({})).toBeNull();
    expect(pickPremium({ bid: 0, lastTrade: 0, model: 0 })).toBeNull();
  });
});

describe("spreadPctOf", () => {
  it("mide el spread contra el mid", () => {
    expect(spreadPctOf(0.9, 1.1)).toBeCloseTo(20, 10);
  });

  it("devuelve null si falta un lado", () => {
    expect(spreadPctOf(0, 1.1)).toBeNull();
  });
});

describe("liquidityBlock — la salvaguarda del proyecto", () => {
  it("bloquea si no hay bid", () => {
    expect(liquidityBlock({ bid: 0, ask: 1.1, openInterest: 900 })).toBe("sin_bid");
  });

  it("bloquea si el spread pasa del 25%", () => {
    expect(liquidityBlock({ bid: 0.5, ask: 0.9, openInterest: 900 })).toBe("spread_ancho");
  });

  it("bloquea si el OI es menor a 100", () => {
    expect(liquidityBlock({ bid: 1, ask: 1.05, openInterest: MIN_OI - 1 })).toBe("oi_bajo");
  });

  it("deja pasar un contrato líquido", () => {
    expect(liquidityBlock({ bid: 1, ask: 1.05, openInterest: 900 })).toBeNull();
  });
});

describe("wheelMetrics", () => {
  it("calcula crédito, colateral, retorno, anualizado y breakeven", () => {
    // Put de F a $11, prima $0.32, spot $11.60, 21 días.
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 21, iv: 0.45 });
    expect(m.credit).toBeCloseTo(32, 10);
    expect(m.collateral).toBeCloseTo(1100, 10);
    expect(m.returnPct).toBeCloseTo((32 / 1100) * 100, 10);
    expect(m.annualizedPct).toBeCloseTo((32 / 1100) * 100 * (365 / 21), 10);
    expect(m.breakeven).toBeCloseTo(10.68, 10);
  });

  it("el colchón se mide desde el breakeven, no desde el strike", () => {
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 21, iv: 0.45 });
    expect(m.cushionPct).toBeCloseTo(((11.6 - 10.68) / 11.6) * 100, 10);
  });

  it("la probabilidad de expirar sin valor sale de probAbove y va en 0-100", () => {
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 21, iv: 0.45 });
    expect(m.probExpireWorthless).toBeGreaterThan(50);
    expect(m.probExpireWorthless).toBeLessThanOrEqual(100);
  });

  it("un DTE de 0 no revienta el anualizado", () => {
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 0, iv: 0.45 });
    expect(Number.isFinite(m.annualizedPct)).toBe(true);
  });
});

import { scoreCandidate, type ScoreInput } from "./wheel";
import type { Level } from "./levels";

function soporte(price: number, strength: number): Level {
  return {
    price, kind: "soporte", strength, distancePct: 0, flipped: false, why: "test",
    sources: { touches: 2, lastTouch: "2026-07-01", openInterest: 0, notional: 0, flowPremium: 0, netGex: 0 },
  };
}

const BASE: ScoreInput = {
  annualizedPct: 25,
  ivRank: 80,
  strike: 11,
  spot: 11.6,
  cushionPct: 8,
  supports: [soporte(11.5, 60)],
  openInterest: 900,
  spreadPct: 5,
  earnings: "fuera",
};

describe("scoreCandidate", () => {
  it("suma 100 en el caso perfecto", () => {
    const s = scoreCandidate(BASE);
    expect(s.total).toBe(100);
  });

  it("castiga el rendimiento por encima del 60% anualizado", () => {
    // Prima así de gorda significa que el mercado sabe algo que tú no.
    const bueno = scoreCandidate({ ...BASE, annualizedPct: 25 }).annualized.points;
    const sospechoso = scoreCandidate({ ...BASE, annualizedPct: 90 }).annualized.points;
    expect(sospechoso).toBeLessThan(bueno);
    expect(sospechoso).toBe(10);
  });

  it("premia el IV Rank ALTO — invertido respecto a ivcontext.ts", () => {
    const alto = scoreCandidate({ ...BASE, ivRank: 80 }).ivRank.points;
    const bajo = scoreCandidate({ ...BASE, ivRank: 20 }).ivRank.points;
    expect(alto).toBeGreaterThan(bajo);
    expect(alto).toBe(20);
    expect(bajo).toBe(4);
  });

  it("premia el strike por debajo de un soporte fuerte", () => {
    const bajoSoporteFuerte = scoreCandidate({ ...BASE, supports: [soporte(11.5, 60)] }).cushion.points;
    const porEncima = scoreCandidate({ ...BASE, strike: 12, supports: [soporte(11.5, 60)] }).cushion.points;
    expect(bajoSoporteFuerte).toBe(25);
    expect(porEncima).toBe(5);
  });

  it("sin soportes pero con buen colchón da puntuación intermedia", () => {
    const s = scoreCandidate({ ...BASE, supports: [], cushionPct: 12 });
    expect(s.cushion.points).toBe(12);
  });

  it("las bandas de liquidez se evalúan en orden y gana la primera", () => {
    // OI alto pero spread del 20%: NO cobra los 15 puntos, cae a la tercera banda.
    const s = scoreCandidate({ ...BASE, openInterest: 800, spreadPct: 20 });
    expect(s.liquidity.points).toBe(5);
  });

  it("penaliza el reporte dentro del vencimiento y lo anula si el skew lo confirma", () => {
    expect(scoreCandidate({ ...BASE, earnings: "fuera" }).earnings.points).toBe(10);
    expect(scoreCandidate({ ...BASE, earnings: "dentro" }).earnings.points).toBe(3);
    expect(scoreCandidate({ ...BASE, earnings: "dentro_confirmado" }).earnings.points).toBe(0);
  });

  it("un ETF sin financials cobra los 10 puntos: no reporta resultados", () => {
    expect(scoreCandidate({ ...BASE, earnings: "no_aplica" }).earnings.points).toBe(10);
  });

  it("sin IV Rank puntúa la banda baja pero no rompe", () => {
    const s = scoreCandidate({ ...BASE, ivRank: null });
    expect(s.ivRank.points).toBe(4);
    expect(Number.isFinite(s.total)).toBe(true);
  });

  it("cada componente explica su porqué en llano", () => {
    const s = scoreCandidate(BASE);
    for (const part of [s.annualized, s.ivRank, s.cushion, s.liquidity, s.earnings]) {
      expect(part.why.length).toBeGreaterThan(10);
      expect(part.points).toBeLessThanOrEqual(part.max);
    }
  });
});

import { atmIv, wheelCandidates, type ChainQuote } from "./wheel";

function quote(p: Partial<ChainQuote>): ChainQuote {
  return {
    strike: 11, expiration: "2026-08-21", dte: 35,
    bid: 0.30, ask: 0.34, lastTrade: 0.32, openInterest: 900, ...p,
  };
}

const CAND_BASE = {
  ticker: "F",
  // 11.7, no 11.6: a 11.6 el delta implícito del strike 11 cae en ~0.31,
  // justo fuera de la banda 0.20-0.30 del preset balanceado (verificado
  // contra blackScholes.ts real). Con 11.7 todos los deltas de este bloque
  // caen dentro de la banda sin tocar el preset ni la fórmula.
  spot: 11.7,
  preset: WHEEL_PRESETS.balanceado,
  ivRank: 60,
  supports: [] as Level[],
  earnings: "fuera" as const,
  fallbackIv: 0.45,
};

describe("wheelCandidates", () => {
  it("descarta los strikes cuyo delta cae fuera del preset", () => {
    // Strike muy lejano: |delta| bajísimo, fuera del rango 0.20-0.30.
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ strike: 5, bid: 0.01, ask: 0.02 })],
    });
    expect(out).toHaveLength(0);
  });

  it("descarta los vencimientos fuera de la ventana de DTE del preset", () => {
    const out = wheelCandidates({ ...CAND_BASE, quotes: [quote({ dte: 3 })] });
    expect(out).toHaveLength(0);
  });

  it("marca como blocked, y sin prima, un contrato ilíquido (OI insuficiente)", () => {
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ bid: 0, ask: 0.34, openInterest: 5 })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].blocked).toBe(true);
    expect(out[0].blockReason).toBe("oi_bajo");
    expect(out[0].premium).toBeNull();
    expect(out[0].metrics).toBeNull();
  });

  it("sin bid en vivo pero con OI y último precio: opera con prima RETRASADA", () => {
    // El caso real hoy: Massive dejó de mandar bid/ask, sí manda day.close.
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ bid: null, ask: null, lastTrade: 0.32, openInterest: 900 })],
    });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.blocked).toBe(false);
    expect(c.premium?.source).toBe("ultimo");
    expect(c.metrics).not.toBeNull();
  });

  it("sin bid, con OI, pero sin ningún precio: bloqueado por falta de datos", () => {
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ bid: null, ask: null, lastTrade: null, openInterest: 900 })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].blocked).toBe(true);
    expect(out[0].blockReason).toBe("sin_dato");
  });

  it("un candidato válido trae delta negativo, métricas y score", () => {
    const out = wheelCandidates({ ...CAND_BASE, quotes: [quote({})] });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.blocked).toBe(false);
    expect(c.delta).toBeLessThan(0);
    expect(c.premium?.source).toBe("bid");
    expect(c.metrics?.collateral).toBeCloseTo(1100, 10);
    expect(c.score?.total).toBeGreaterThan(0);
  });

  it("marca la fila cuando la IV implícita no converge y cae al fallback", () => {
    // Quote cruzada e imposible: la bisección no puede converger.
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ bid: 20, ask: 21, lastTrade: 20.5 })],
    });
    expect(out[0]?.ivSource).toBe("estimada");
  });

  it("ordena de mayor a menor score y deja los bloqueados al final", () => {
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [
        quote({ strike: 11, bid: 0, ask: 0.34, openInterest: 5 }),
        quote({ strike: 10.5, bid: 0.28, ask: 0.30, openInterest: 2000 }),
      ],
    });
    expect(out[0].blocked).toBe(false);
    expect(out[out.length - 1].blocked).toBe(true);
  });
});

describe("atmIv", () => {
  it("devuelve la IV del strike más cercano al spot", () => {
    const iv = atmIv([
      { strike: 8, iv: 0.9 },
      { strike: 11.5, iv: 0.45 },
      { strike: 20, iv: 0.7 },
    ], 11.6);
    expect(iv).toBe(0.45);
  });

  it("devuelve null sin datos", () => {
    expect(atmIv([], 11.6)).toBeNull();
  });
});

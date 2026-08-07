import { describe, expect, it } from "vitest";
import {
  MAX_THETA_PCT_DAILY,
  MIN_DTE,
  MONEYNESS_CAP,
  THETA_BUDGET_PCT,
  budgetsOf,
  passesQualityFilter,
  sizeFlow,
  withinMoneyness,
  type RiskProfile,
} from "./risk";
import type { FlowRow } from "./flow";

const PROFILE: RiskProfile = { accountSize: 10_000, tolerancePct: 4 };
/** Tolerancia por encima de la banda de theta — ahí es donde el theta puede frenar. */
const AGRESIVO: RiskProfile = { accountSize: 10_000, tolerancePct: 10 };

function row(p: Partial<FlowRow>): FlowRow {
  return {
    id: 1, symbol: "NVDA260919C00220000", underlying: "NVDA", type: "call",
    strike: 220, expiration: "2026-09-19", dte: 57, price: 2.1, size: 100,
    side: "ask", aggression: "ask", assetPrice: 210, bid: 2.0, ask: 2.2,
    premium: 210_000, delta: 0.55, gamma: 0.02, theta: -0.08, vega: 0.1,
    thetaPctDaily: 3.81, iv: 0.5, openInterest: 1000, volume: 500, score: 80,
    sentiment: "bullish", timestamp: "2026-07-24T14:00:00Z",
    conditionCode: null, conditionName: null,
    flags: { multileg: false } as FlowRow["flags"],
    scores: {} as FlowRow["scores"],
    unusual: true, interesting: true, expiryStatus: "vigente",
    ...p,
  } as FlowRow;
}

describe("budgetsOf — dos presupuestos, un solo slider", () => {
  it("el de prima sale de la tolerancia; el de theta de la banda del scorecard", () => {
    const b = budgetsOf(PROFILE);
    expect(b.premium).toBe(400); // 4% de $10,000
    expect(b.theta).toBe(500); // 5% fijo (banda de Inusualidad)
  });

  it("el presupuesto de theta no depende del slider", () => {
    expect(budgetsOf(PROFILE).theta).toBe(budgetsOf(AGRESIVO).theta);
  });

  it("nunca devuelve negativo ni NaN con entradas basura", () => {
    for (const p of [
      { accountSize: -5, tolerancePct: 4 },
      { accountSize: NaN, tolerancePct: 4 },
      { accountSize: 10_000, tolerancePct: -2 },
    ]) {
      const b = budgetsOf(p as RiskProfile);
      expect(b.premium).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(b.premium)).toBe(true);
      expect(Number.isFinite(b.theta)).toBe(true);
    }
  });
});

describe("passesQualityFilter — capa 1 (calidad del contrato)", () => {
  it("acepta un contrato sano", () => {
    expect(passesQualityFilter(row({})).ok).toBe(true);
  });

  it("descarta la lotería: theta por encima del 5% diario", () => {
    const r = passesQualityFilter(row({ thetaPctDaily: 7.8 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("theta_alto");
  });

  it("acepta justo en el límite del 5% y rechaza apenas encima", () => {
    expect(passesQualityFilter(row({ thetaPctDaily: MAX_THETA_PCT_DAILY })).ok).toBe(true);
    expect(passesQualityFilter(row({ thetaPctDaily: MAX_THETA_PCT_DAILY + 0.01 })).ok).toBe(false);
  });

  it("descarta si MarketSnack no trajo theta — no se estima", () => {
    const r = passesQualityFilter(row({ thetaPctDaily: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sin_theta");
  });

  it("descarta contratos ya vencidos o que expiran hoy", () => {
    expect(passesQualityFilter(row({ expiryStatus: "expirado" })).reason).toBe("vencido");
    expect(passesQualityFilter(row({ expiryStatus: "expira_hoy" })).reason).toBe("vencido");
  });

  it("descarta lo que expira demasiado pronto para operarlo", () => {
    expect(passesQualityFilter(row({ dte: MIN_DTE - 1 })).reason).toBe("vencido");
    expect(passesQualityFilter(row({ dte: MIN_DTE })).ok).toBe(true);
  });
});

describe("sizeFlow — capa 2 (sizing contra la cuenta)", () => {
  it("el caso trabajado del plan: prima $2.10, cuenta $10k al 4% → 1 contrato, frena la prima", () => {
    const s = sizeFlow(row({}), PROFILE, 20);
    // prima: $400/$210 = 1 · theta: $500/$160 = 3 → gana el menor
    expect(s.maxContracts).toBe(1);
    expect(s.binding).toBe("prima");
    expect(s.costPerContract).toBe(210);
    expect(s.thetaBurnPerContract).toBeCloseTo(160, 5);
    expect(s.totalCost).toBe(210);
    expect(s.costPctOfAccount).toBeCloseTo(2.1, 5);
  });

  it("con tolerancia por encima del 5%, el theta sí frena", () => {
    const s = sizeFlow(row({}), AGRESIVO, 20);
    // prima: $1,000/$210 = 4 · theta: $500/$160 = 3 → frena el theta
    expect(s.maxContracts).toBe(3);
    expect(s.binding).toBe("theta");
    expect(s.totalBurn).toBeCloseTo(480, 5);
    expect(s.burnPctOfAccount).toBeCloseTo(4.8, 5);
  });

  it("la quema nunca supera el costo del contrato y marca fullyDecays", () => {
    // En el límite de la banda (5%/día) el contrato se consume solo en 20 días;
    // a 30 días de horizonte la quema cruda excedería la prima.
    const s = sizeFlow(row({ price: 1, theta: -0.05, thetaPctDaily: 5 }), PROFILE, 30);
    // sin tope serían 0.05×100×30 = $150 por un contrato que solo cuesta $100
    expect(s.thetaBurnPerContract).toBe(100);
    expect(s.fullyDecays).toBe(true);
  });

  it("los días de quema se recortan al vencimiento: un contrato a 8 días no quema 20", () => {
    const corto = sizeFlow(row({ dte: 8 }), PROFILE, 20);
    const largo = sizeFlow(row({ dte: 57 }), PROFILE, 20);
    expect(corto.burnDays).toBe(8);
    expect(largo.burnDays).toBe(20);
    expect(corto.thetaBurnPerContract).toBeLessThan(largo.thetaBurnPerContract);
  });

  it("un horizonte más largo aprieta el límite, nunca lo afloja", () => {
    const barato = { price: 0.4, theta: -0.01, thetaPctDaily: 2.5 };
    const a = sizeFlow(row(barato), AGRESIVO, 10);
    const b = sizeFlow(row(barato), AGRESIVO, 30);
    expect(b.maxContracts).toBeLessThan(a.maxContracts);
  });

  it("cuenta que no alcanza ni para un contrato → 0, sin binding falso", () => {
    const s = sizeFlow(row({ price: 50 }), { accountSize: 1_000, tolerancePct: 4 }, 20);
    expect(s.maxContracts).toBe(0);
    expect(s.totalCost).toBe(0);
  });

  it("entradas degeneradas no producen NaN ni Infinity", () => {
    for (const p of [
      { accountSize: 0, tolerancePct: 4 },
      { accountSize: 10_000, tolerancePct: 0 },
      { accountSize: NaN, tolerancePct: NaN },
    ]) {
      const s = sizeFlow(row({}), p as RiskProfile, 20);
      expect(s.maxContracts).toBe(0);
      expect(Number.isFinite(s.totalCost)).toBe(true);
      expect(Number.isFinite(s.burnPctOfAccount)).toBe(true);
    }
  });

  it("precio de contrato en cero no revienta la división", () => {
    const s = sizeFlow(row({ price: 0 }), PROFILE, 20);
    expect(s.maxContracts).toBe(0);
    expect(Number.isFinite(s.costPerContract)).toBe(true);
  });
});

describe("sizeFlow — salvaguardas (regla de CLAUDE.md)", () => {
  it("cadena ilíquida bloquea el sizing por completo: sin número de contratos", () => {
    const s = sizeFlow(row({}), PROFILE, 20, { lowLiquidity: true });
    expect(s.blocked?.reason).toBe("iliquidez");
    expect(s.maxContracts).toBe(0);
  });

  it("la iliquidez manda aunque el contrato sea impecable", () => {
    const bueno = { price: 0.2, theta: -0.001, thetaPctDaily: 0.5 };
    expect(sizeFlow(row(bueno), PROFILE, 20).maxContracts).toBeGreaterThan(0);
    expect(sizeFlow(row(bueno), PROFILE, 20, { lowLiquidity: true }).maxContracts).toBe(0);
  });

  it("un contrato que no pasa la capa 1 llega bloqueado, no dimensionado", () => {
    const s = sizeFlow(row({ thetaPctDaily: 9 }), PROFILE, 20);
    expect(s.blocked?.reason).toBe("theta_alto");
    expect(s.maxContracts).toBe(0);
  });

  it("sin theta real no se dimensiona (no se estima con Black-Scholes)", () => {
    const s = sizeFlow(row({ thetaPctDaily: null, theta: 0 }), PROFILE, 20);
    expect(s.blocked?.reason).toBe("sin_theta");
    expect(s.maxContracts).toBe(0);
  });
});

describe("withinMoneyness — contratos más cercanos", () => {
  it("acepta un strike pegado al precio (ATM)", () => {
    expect(withinMoneyness(row({ strike: 210, assetPrice: 210 }))).toBe(true);
  });

  it("acepta dentro de la banda y rechaza justo fuera", () => {
    // banda por defecto ±25% sobre spot 200 → hasta 250 dentro, 251 fuera
    expect(withinMoneyness(row({ strike: 250, assetPrice: 200 }))).toBe(true);
    expect(withinMoneyness(row({ strike: 251, assetPrice: 200 }))).toBe(false);
  });

  it("rechaza lo muy OTM (lotería barata) y lo muy ITM (caro)", () => {
    expect(withinMoneyness(row({ strike: 400, assetPrice: 200 }))).toBe(false); // +100%
    expect(withinMoneyness(row({ strike: 80, assetPrice: 200 }))).toBe(false); // −60%
  });

  it("respeta una banda personalizada", () => {
    expect(withinMoneyness(row({ strike: 220, assetPrice: 200 }), 0.05)).toBe(false);
    expect(withinMoneyness(row({ strike: 220, assetPrice: 200 }), 0.15)).toBe(true);
  });

  it("con datos faltantes no filtra: la cercanía es preferencia, no salvaguarda", () => {
    expect(withinMoneyness(row({ strike: null }))).toBe(true);
    expect(withinMoneyness(row({ assetPrice: 0 }))).toBe(true);
  });

  it("MONEYNESS_CAP es una fracción razonable (0-1)", () => {
    expect(MONEYNESS_CAP).toBeGreaterThan(0);
    expect(MONEYNESS_CAP).toBeLessThanOrEqual(1);
  });
});

describe("THETA_BUDGET_PCT", () => {
  it("está dentro de la banda 3-5% del documento de Inusualidad", () => {
    expect(THETA_BUDGET_PCT).toBeGreaterThanOrEqual(3);
    expect(THETA_BUDGET_PCT).toBeLessThanOrEqual(5);
  });
});

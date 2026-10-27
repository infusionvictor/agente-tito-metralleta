import { describe, expect, it } from "vitest";
import { bsPrice } from "./blackScholes";
import {
  MIN_INTRADAY_CONFIDENCE,
  MIN_SWING_HITRATE,
  buildAutoTradeInput,
  evaluateIntraday,
  evaluateSwing,
  pickNearestContract,
  refPrice,
  type ContractCandidate,
} from "./autopilot";

function contract(overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  return { strike: 20, expiration: "2026-09-18", dte: 20, bid: 1.0, ask: 1.2, lastTrade: 1.1, ...overrides };
}

describe("refPrice", () => {
  it("usa el mid si hay bid y ask", () => {
    expect(refPrice(contract({ bid: 1, ask: 1.2 }))).toBeCloseTo(1.1);
  });
  it("cae al último trade sin bid/ask", () => {
    expect(refPrice(contract({ bid: null, ask: null, lastTrade: 0.9 }))).toBe(0.9);
  });
  it("null si no hay ningún precio", () => {
    expect(refPrice(contract({ bid: null, ask: null, lastTrade: null }))).toBeNull();
  });
});

describe("pickNearestContract", () => {
  it("elige el strike más cercano dentro de la ventana de DTE", () => {
    const cands = [contract({ strike: 15, dte: 20 }), contract({ strike: 22, dte: 20 }), contract({ strike: 30, dte: 20 })];
    expect(pickNearestContract(cands, 21)?.strike).toBe(22);
  });

  it("descarta contratos fuera de la ventana de DTE (0DTE / muy lejanos)", () => {
    const cands = [contract({ strike: 20, dte: 1 }), contract({ strike: 20, dte: 90 })];
    expect(pickNearestContract(cands, 20)).toBeNull();
  });

  it("descarta contratos sin precio disponible", () => {
    const cands = [contract({ strike: 20, bid: null, ask: null, lastTrade: null })];
    expect(pickNearestContract(cands, 20)).toBeNull();
  });
});

describe("evaluateIntraday", () => {
  const base = {
    ticker: "WULF",
    spot: 20,
    iv: 0.6,
    gexDirection: "up" as const,
    gexConfidence: 70,
    kingStrike: 25,
    lowLiquidity: false,
    keySupport: { price: 18, strength: 40 },
    keyResistance: { price: 22, strength: 50 },
    contracts: [contract({ strike: 22, dte: 20 })],
  };

  it("call en ruptura de resistencia, con objetivo/stop calculados vía Black-Scholes sobre niveles reales", () => {
    const cand = evaluateIntraday(base);
    expect(cand?.contractType).toBe("call");
    expect(cand?.direction).toBe("up");
    expect(cand?.entryTrigger).toBe(22);
    expect(cand?.probability).toBe(70);

    const T = 20 / 365;
    const expectedTarget = Math.round(bsPrice(25, 22, T, 0.6, "call") * 100) / 100;
    const expectedStop = Math.round(bsPrice(18, 22, T, 0.6, "call") * 100) / 100;
    expect(cand?.target).toBeCloseTo(expectedTarget);
    expect(cand?.stop).toBeCloseTo(expectedStop);
    expect(cand!.target).toBeGreaterThan(cand!.stop);
  });

  it("put en ruptura de soporte cuando GEX apunta abajo, con kingStrike por debajo", () => {
    const cand = evaluateIntraday({ ...base, gexDirection: "down", kingStrike: 15 });
    expect(cand?.contractType).toBe("put");
    expect(cand?.entryTrigger).toBe(18);
    expect(cand!.target).toBeGreaterThan(cand!.stop);
  });

  it("no entra por debajo del umbral de confianza", () => {
    expect(evaluateIntraday({ ...base, gexConfidence: MIN_INTRADAY_CONFIDENCE - 1 })).toBeNull();
  });

  it("no entra en cadena ilíquida aunque la confianza sea alta", () => {
    expect(evaluateIntraday({ ...base, lowLiquidity: true })).toBeNull();
  });

  it("no entra sin nodo GEX (sin objetivo real que proyectar)", () => {
    expect(evaluateIntraday({ ...base, kingStrike: null })).toBeNull();
  });

  it("no entra si falta CUALQUIERA de los dos niveles reales (gatillo o stop)", () => {
    expect(evaluateIntraday({ ...base, keyResistance: null })).toBeNull();
    expect(evaluateIntraday({ ...base, keySupport: null })).toBeNull();
  });

  it("no entra sin contrato con precio disponible", () => {
    expect(evaluateIntraday({ ...base, contracts: [] })).toBeNull();
  });

  it("no entra sin IV válida", () => {
    expect(evaluateIntraday({ ...base, iv: 0 })).toBeNull();
  });
});

describe("evaluateSwing", () => {
  const base = {
    ticker: "TSLA",
    type: "call" as const,
    strike: 250,
    expiration: "2026-10-16",
    dte: 25,
    iv: 0.5,
    assetPrice: 240,
    price: 3.5,
    hitRate: 70,
    resolved: 8,
    avgMfePct: 6,
    avgMaePct: 3,
  };

  it("entra cuando hay acierto histórico suficiente, gatillo por encima del spot para calls", () => {
    const cand = evaluateSwing(base);
    expect(cand?.direction).toBe("up");
    expect(cand?.entryTrigger).toBeCloseTo(240 * 1.003);

    const T = 25 / 365;
    const expectedTarget = Math.round(bsPrice(240 * 1.06, 250, T, 0.5, "call") * 100) / 100;
    const expectedStop = Math.round(bsPrice(240 * 0.97, 250, T, 0.5, "call") * 100) / 100;
    expect(cand?.target).toBeCloseTo(expectedTarget);
    expect(cand?.stop).toBeCloseTo(expectedStop);
  });

  it("puts confirman hacia abajo, con objetivo por debajo del spot", () => {
    const cand = evaluateSwing({ ...base, type: "put" });
    expect(cand?.direction).toBe("down");
    expect(cand?.entryTrigger).toBeCloseTo(240 * 0.997);
    expect(cand!.target).toBeGreaterThan(cand!.stop);
  });

  it("sin historial (hitRate null) no autopilotea", () => {
    expect(evaluateSwing({ ...base, hitRate: null })).toBeNull();
  });

  it("con pocas muestras no autopilotea aunque el acierto sea alto", () => {
    expect(evaluateSwing({ ...base, resolved: 1 })).toBeNull();
  });

  it("por debajo del umbral de acierto no autopilotea", () => {
    expect(evaluateSwing({ ...base, hitRate: MIN_SWING_HITRATE - 1 })).toBeNull();
  });

  it("sin excursión histórica real (avgMfe/avgMae) no autopilotea", () => {
    expect(evaluateSwing({ ...base, avgMfePct: null })).toBeNull();
    expect(evaluateSwing({ ...base, avgMaePct: null })).toBeNull();
  });
});

describe("buildAutoTradeInput", () => {
  it("pasa el objetivo/stop/gatillo del candidato tal cual, sin recalcular", () => {
    const cand = evaluateIntraday({
      ticker: "WULF", spot: 20, iv: 0.6, gexDirection: "up", gexConfidence: 80, kingStrike: 25,
      lowLiquidity: false,
      keySupport: { price: 18, strength: 40 }, keyResistance: { price: 22, strength: 50 },
      contracts: [contract({ strike: 22, dte: 20 })],
    })!;
    const input = buildAutoTradeInput(cand);
    expect(input.source).toBe("auto");
    expect(input.target).toBe(cand.target);
    expect(input.stop).toBe(cand.stop);
    expect(input.entryTrigger).toBe(cand.entryTrigger);
    expect(input.path).toBe("intraday");
    expect(input.contracts).toBe(1);
    expect(input.note).toMatch(/Intradía/);
  });
});

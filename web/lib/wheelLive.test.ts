import { describe, it, expect } from "vitest";
import { liveKey, liveQuoteMap } from "./wheelLive";
import type { RawTrade } from "./flow";

// OCC: SOFI, put, strike 8.00, vence 2026-08-21.
const SOFI_P8 = "SOFI260821P00008000";
const SOFI_C8 = "SOFI260821C00008000";

function trade(symbol: string, bid: number, ask: number, ts: string): RawTrade {
  return {
    id: 1, symbol, price: 0.5, size: 10, side: "MIDMKT",
    bid_price: bid, ask_price: ask, premium: 5000, delta: -0.25,
    implied_volatility: 0.5, open_interest: 500, timestamp: ts,
  } as unknown as RawTrade;
}

describe("liveKey", () => {
  it("normaliza el strike a 2 decimales", () => {
    expect(liveKey(8, "2026-08-21")).toBe("8.00|2026-08-21");
    expect(liveKey(7.5, "2026-08-21")).toBe("7.50|2026-08-21");
  });
});

describe("liveQuoteMap", () => {
  it("cruza puts y arma la clave strike|vencimiento", () => {
    const m = liveQuoteMap([trade(SOFI_P8, 0.4, 0.45, "2026-07-25T14:00:00Z")]);
    expect(m.get("8.00|2026-08-21")).toEqual({ bid: 0.4, ask: 0.45 });
  });

  it("se queda con el trade MAS RECIENTE de cada contrato", () => {
    const m = liveQuoteMap([
      trade(SOFI_P8, 0.4, 0.45, "2026-07-25T14:00:00Z"),
      trade(SOFI_P8, 0.55, 0.6, "2026-07-25T15:30:00Z"), // el mas nuevo
      trade(SOFI_P8, 0.2, 0.25, "2026-07-25T09:31:00Z"),
    ]);
    expect(m.get("8.00|2026-08-21")).toEqual({ bid: 0.55, ask: 0.6 });
  });

  it("ignora calls, horquillas invalidas y simbolos ilegibles", () => {
    const m = liveQuoteMap([
      trade(SOFI_C8, 0.4, 0.45, "2026-07-25T14:00:00Z"),   // call: fuera
      trade(SOFI_P8, 0, 0.45, "2026-07-25T14:00:00Z"),     // bid 0
      trade(SOFI_P8, 0.6, 0.5, "2026-07-25T14:00:00Z"),    // cruzada ask<bid
      trade("BASURA", 0.4, 0.45, "2026-07-25T14:00:00Z"),  // simbolo invalido
    ]);
    expect(m.size).toBe(0);
  });
});

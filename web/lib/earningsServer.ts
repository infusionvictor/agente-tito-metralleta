// Orquestación server-side del cómputo de Earnings IV-Crush para UN ticker.
// Reusado por /api/earnings (drill-down) y /api/earnings-scan (escáner).
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

import { fetchCompany, fetchDailyBars, fetchChainQuotes, fetchEarningsDates } from "./massive";
import {
  impliedEarningsMove,
  historicalEarningsMoves,
  earningsRichness,
  atmStraddle,
  atmIv,
  type Richness,
} from "./earningsMove";
import {
  suggestCreditSpreads,
  suggestSpreadsAtSigma,
  type OptionQuote,
  type Spread,
} from "./premiumSell";
import { estimateNextEarnings } from "./earnings";
import { marketDateStr } from "./occ";

type SpreadPair = { putSpread: Spread | null; callSpread: Spread | null };

export interface EarningsResult extends Richness {
  ticker: string;
  spot: number | null;
  method: "straddle" | "iv" | null;
  /** IV del ATM en %, y flag de IV alta (>100%) para priorizar. */
  ivPct: number | null;
  ivHigh: boolean;
  /** σ (1 desviación estándar) del vencimiento más cercano, en % y en $. */
  sigmaPct: number | null;
  sigmaAbs: number | null;
  /** desbalance call/put del posicionamiento OTM de la cadena (dónde está más cargado el dinero). */
  flow: { callPct: number; putPct: number } | null;
  /** true si la data de opciones del ATM es de una sesión anterior (no operó hoy) → no fiable. */
  stale: boolean;
  straddle: { strike: number; expiration: string; dte: number } | null;
  /** spread estándar (delta≈0.20, fuera de 1σ). */
  spreads: SpreadPair | null;
  /** ventas de prima en los extremos: por delta≈0.10 y por ±2σ. */
  spreadsExtremos: { byDelta: SpreadPair; bySigma: SpreadPair } | null;
  moves: number[];
  nextEarnings: string | null;
}

export async function computeEarnings(
  ticker: string,
  opts: { withSpreads?: boolean } = {},
): Promise<EarningsResult> {
  const clean = ticker.trim().toUpperCase();

  const [company, bars, dates] = await Promise.all([
    fetchCompany(clean).catch(() => null),
    fetchDailyBars(clean, 900).catch(() => []),
    fetchEarningsDates(clean).catch(() => []),
  ]);

  const spot0 = company?.price ?? null;
  const chain = spot0 ? await fetchChainQuotes(clean, spot0).catch(() => null) : null;
  const s = chain?.spot ?? spot0 ?? 0;

  // Move implícito: PRIORIDAD al método σ = IV_ATM·√(DTE/365) del vencimiento más cercano
  // (robusto; evita el bug del straddle mal-priced). Fallback al straddle si no hay IV.
  const iv = chain ? atmIv(chain.quotes, s) : null; // decimal
  const straddle = chain ? atmStraddle(chain.quotes, s) : null;
  const implied =
    iv != null && chain
      ? impliedEarningsMove({ spot: s, atmIv: iv, dteDays: chain.dte })
      : straddle
        ? impliedEarningsMove({ spot: s, callPrice: straddle.callPrice, putPrice: straddle.putPrice })
        : null;

  const hist = historicalEarningsMoves(bars, dates);
  const richness = earningsRichness(implied?.impliedMovePct ?? null, hist);
  const nextEarnings = estimateNextEarnings(dates, new Date());

  const ivPct = iv != null ? iv * 100 : null;
  const sigmaPct = implied?.impliedMovePct ?? null;
  const sigmaAbs = sigmaPct != null && s > 0 ? (sigmaPct / 100) * s : null;

  // Desbalance call/put: premium OTM de la cadena cercana (calls sobre spot, puts bajo spot).
  let flow: { callPct: number; putPct: number } | null = null;
  if (chain && s > 0) {
    let callPrem = 0;
    let putPrem = 0;
    for (const q of chain.quotes) {
      const prem = q.price * q.oi;
      if (q.type === "call" && q.strike >= s) callPrem += prem;
      else if (q.type === "put" && q.strike <= s) putPrem += prem;
    }
    const tot = callPrem + putPrem;
    if (tot > 0) {
      const callPct = Math.round((callPrem / tot) * 100);
      flow = { callPct, putPct: 100 - callPct };
    }
  }

  // Data stale: si el contrato ATM se actualizó por última vez en una sesión ANTERIOR
  // (no operó hoy), la IV/precio son viejos (ej. pre-earnings tras reportar) → no fiable.
  let stale = false;
  if (chain && s > 0) {
    const atm = chain.quotes
      .filter((q) => q.lastUpdatedMs != null && Math.abs(q.strike - s) / s <= 0.03)
      .sort((a, b) => Math.abs(a.strike - s) - Math.abs(b.strike - s))[0];
    if (atm?.lastUpdatedMs != null) {
      stale = marketDateStr(new Date(atm.lastUpdatedMs)) < marketDateStr(new Date());
    }
  }

  let spreads: SpreadPair | null = null;
  let spreadsExtremos: EarningsResult["spreadsExtremos"] = null;
  if (opts.withSpreads && chain && sigmaPct != null && s > 0) {
    const quotes: OptionQuote[] = chain.quotes
      .filter((q) => q.delta != null)
      .map((q) => ({ strike: q.strike, type: q.type, price: q.price, delta: q.delta!, oi: q.oi }));
    const walls = { supports: [], resistances: [] };
    const width = Math.max(1, Math.round(s * 0.025));

    const std = suggestCreditSpreads(quotes, s, walls, sigmaPct, { targetDelta: 0.2, width });
    spreads = { putSpread: std.putSpread, callSpread: std.callSpread };

    const byDelta = suggestCreditSpreads(quotes, s, walls, sigmaPct, { targetDelta: 0.1, width });
    const bySigma = suggestSpreadsAtSigma(quotes, s, walls, sigmaPct, { sigmaMult: 2, width });
    spreadsExtremos = {
      byDelta: { putSpread: byDelta.putSpread, callSpread: byDelta.callSpread },
      bySigma,
    };
  }

  return {
    ticker: clean,
    ...richness,
    moves: hist.moves,
    spot: s || null,
    method: implied?.method ?? null,
    ivPct,
    ivHigh: ivPct != null && ivPct > 100,
    sigmaPct,
    sigmaAbs,
    flow,
    stale,
    straddle:
      chain && straddle
        ? { strike: straddle.strike, expiration: chain.expiration, dte: chain.dte }
        : null,
    spreads,
    spreadsExtremos,
    nextEarnings,
  };
}

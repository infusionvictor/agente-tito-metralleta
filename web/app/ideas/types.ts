// Tipos compartidos entre la ruta /api/ideas y la página /ideas.

export interface IdeaHistory {
  /** % de flows pasados de ese ticker que acabaron moviéndose a favor. */
  hitRate: number | null;
  /** Sesiones que tardó la mediana en desarrollarse. */
  medianSessions: number | null;
  /** Sobre cuántos flows vencidos se calculó. */
  resolved: number;
}

export interface Idea {
  id: number;
  ticker: string;
  symbol: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  price: number;
  theta: number;
  thetaPctDaily: number | null;
  delta: number;
  premium: number;
  size: number;
  aggression: string;
  assetPrice: number;
  iv: number;
  openInterest: number;
  timestamp: string;
  unusualScore: number;
  repeated: boolean;
  history: IdeaHistory | null;
}

export interface IdeasMeta {
  scanned: number;
  pages: number;
  truncated: boolean;
  tickers: number;
  withHistory: number;
  savedTickers: number;
  /** Cuántos contratos tumbó cada regla de la capa 1. */
  rejected: {
    theta_alto: number;
    vencido: number;
    sin_theta: number;
    no_inusual: number;
    /** Strike demasiado lejos del precio (fuera de la banda de cercanía). */
    lejano: number;
  };
  minPremium: number;
  /** Banda de cercanía del strike al precio, |strike − spot| / spot. */
  moneynessCap: number;
  period: string;
  generatedAt: string;
}

export type IdeasEvent =
  | { type: "step"; label: string; detail?: string }
  | { type: "done"; ideas: Idea[]; meta: IdeasMeta }
  | { type: "error"; message: string };

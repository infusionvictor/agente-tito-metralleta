// Tarea 3 del Proceso Principal (nunca implementada): "Comparación sectorial
// vs. individual" — identificar los 5 líderes del sector de la empresa
// consultada y comparar su flujo para etiquetar si la actividad es sectorial
// (rota todo el sector) o individual (conviction específica en esa empresa).
//
// Massive no deja buscar dinámicamente "los líderes de este sector" — el
// filtro `sic_code` del endpoint de referencia lo ignora en silencio y
// devuelve resultados sin filtrar (confirmado a mano). Por eso esto es una
// lista curada por sector, igual que WHEEL_UNIVERSE: no es exhaustiva, pero
// cubre los sectores más comunes con nombres reales y bien conocidos.
//
// El emparejamiento usa el `sic_description` que Massive sí trae por ticker
// (confirmado con ~50 tickers reales) y hace match por palabra clave, no por
// código SIC exacto — junta categorías SIC vecinas bajo un sector "humano"
// (ej. tiendas de variedad + catálogo/mail-order = "Retail"), que es más útil
// que la pureza taxonómica para esto. Puro y testeado (sectors.test.ts).

export interface SectorGroup {
  name: string;
  /** Palabras clave (mayúsculas) que deben aparecer en el sic_description. */
  keywords: string[];
  /** Líderes conocidos del sector — aproximación curada, no un ranking oficial. */
  leaders: string[];
}

export const SECTOR_GROUPS: SectorGroup[] = [
  { name: "Semiconductores", keywords: ["SEMICONDUCTOR"], leaders: ["NVDA", "AVGO", "AMD", "TXN", "MU"] },
  { name: "Software empresarial", keywords: ["PREPACKAGED SOFTWARE"], leaders: ["MSFT", "ORCL", "CRM", "ADBE", "NOW"] },
  { name: "Internet y datos", keywords: ["COMPUTER PROGRAMMING", "DATA PROCESSING"], leaders: ["GOOGL", "META", "SNAP", "PINS"] },
  { name: "Retail / Consumo", keywords: ["RETAIL-", "CATALOG & MAIL-ORDER"], leaders: ["AMZN", "WMT", "COST", "TGT", "HD"] },
  { name: "Bancos", keywords: ["COMMERCIAL BANKS"], leaders: ["JPM", "BAC", "WFC", "C"] },
  { name: "Pagos y servicios financieros", keywords: ["BUSINESS SERVICES"], leaders: ["V", "MA", "PYPL"] },
  { name: "Farmacéuticas", keywords: ["PHARMACEUTICAL"], leaders: ["LLY", "JNJ", "PFE", "ABBV", "MRK"] },
  { name: "Petróleo y gas", keywords: ["PETROLEUM", "OIL & GAS"], leaders: ["XOM", "CVX", "COP", "EOG", "SLB"] },
  { name: "Automotriz", keywords: ["MOTOR VEHICLES"], leaders: ["TSLA", "GM", "F", "RIVN"] },
  { name: "Aerolíneas", keywords: ["AIR TRANSPORTATION"], leaders: ["DAL", "UAL", "LUV"] },
  { name: "Telecomunicaciones", keywords: ["TELEPHONE COMMUNICATIONS", "RADIOTELEPHONE", "CABLE & OTHER PAY"], leaders: ["T", "VZ", "TMUS", "CMCSA"] },
  { name: "Hardware / Computadoras", keywords: ["ELECTRONIC COMPUTERS"], leaders: ["AAPL", "DELL", "SMCI"] },
];

/** ¿A qué grupo pertenece este sic_description? null si no cae en ninguno mapeado. */
export function sectorFor(sicDescription: string | null): SectorGroup | null {
  if (!sicDescription) return null;
  const upper = sicDescription.toUpperCase();
  return SECTOR_GROUPS.find((g) => g.keywords.some((k) => upper.includes(k))) ?? null;
}

/** Los líderes del sector, sin el ticker que ya se está analizando. */
export function sectorPeers(sicDescription: string | null, excludeTicker: string): string[] {
  const group = sectorFor(sicDescription);
  if (!group) return [];
  const exclude = excludeTicker.trim().toUpperCase();
  return group.leaders.filter((t) => t !== exclude);
}

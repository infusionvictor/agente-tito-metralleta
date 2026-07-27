# Tito Metralleta — Guía para estudiantes

Qué estamos construyendo, cómo funciona y hacia dónde va. Este documento acompaña la app
(`web/`) y sirve como material de estudio.

---

## 1. Idea general

**Tito Metralleta** es un sistema que analiza el **flujo de opciones** (options flow) de una acción
y lo resume en un **scorecard**: una tarjeta que puntúa una oportunidad de 0 a 100, combinando
6 categorías. El objetivo no es traer "todo el tape", sino **producir un reporte** que diga qué tan
fuerte e inusual es la actividad, y dónde está pegando el dinero grande.

Se usa por ticker: buscas `TSLA` → ves empresa, scorecard, gráfica de flujo y transacciones notables.

---

## 2. Las 6 categorías del Scorecard

| # | Categoría | Pregunta | Peso |
|---|-----------|----------|------|
| 1 | **Agresividad** | ¿Compran al ask con fuerza? | 20% |
| 2 | Convicción | ¿Cuánto dinero real entró? | 20% |
| 3 | Inusualidad | ¿Es flujo anormal? (Vol/OI) | 20% |
| 4 | Estructura | ¿Strike/DTE de convicción o lotería? | 15% |
| 5 | Contexto IV | ¿IV limpia o inflada? | 10% |
| 6 | Confirmación de Precio | ¿El precio valida o absorbe? | 15% |

Cada categoría recibe un **score de 0 a 10**, se multiplica por su peso, y la suma da el **/100**.
Bandas: **0–49 débil · 50–74 moderada · 75–100 fuerte**.

Hoy las **categorías 1 (Agresividad), 2 (Convicción), 3 (Inusualidad) y 4 (Estructura) ya están
vivas**; las otras 2 se irán construyendo (cada una rellena su casilla y el /100 cobra sentido).

---

## 3. De dónde salen los datos

Dos fuentes, cada una para lo que hace bien:

- **Massive** (`api.massive.com`, ex-Polygon) — datos de mercado: option chain (Open Interest,
  volumen), precio del subyacente (barras diarias e intradía), greeks e IV. **No da bid/ask** en
  nuestro plan.
- **MarketSnack** (`app.marketsnack.com`) — flujo de opciones ya procesado, con lo que a Massive
  le falta: **bid/ask y el lado de cada trade** (`AT_ASK`, `ASKSIDE`, `AT_BID`, `BIDSIDE`, `MIDMKT`),
  premium, delta, score. Se consulta con la cookie de sesión.

**Dato clave:** ambos consumen el mismo feed OPRA, así que un mismo trade se puede **emparejar 1-a-1
por `sequence_number`**. Por eso podemos usar Massive para "qué transacciones" y MarketSnack para
"en bid o ask".

---

## 4. Sub-agente 1 — Agresividad (Time & Sales)

Mide si el dinero grande entra **agresivo al ask** (comprando fuerte) o **golpea el bid** (vendiendo).

### Cómo trabaja
1. Trae solo las **transacciones notables** (filtro server-side `premium ≥ $100K`, pocas páginas).
   No trae el tape completo — es un **reporte**, no un volcado.
2. Cada trade se etiqueta por **lado** (ask / bid / mid) y se marcan las **interesantes**:
   - ≥ $1M de premium
   - ≥ $100K con |Δ| > 0.60
   - Above Ask / Below Bid (los MID se descartan por ahora)
   - Repetidas en 5 minutos
   - Multileg (mismo timestamp, distintos contratos del mismo subyacente)
   - Prioridad a LEAPs (vencimientos largos)
3. Se calcula el **Score de Agresividad (0–10)** (dirección del dinero):

   ```
   premium_ask = Σ premium de las notables en el ask
   premium_bid = Σ premium de las notables en el bid
   ratio = premium_ask / (premium_ask + premium_bid)   → 0..1
   Score = round(ratio × 10)                            → 0..10
   ```
   10 = todo el dinero grande entrando al ask · 0 = todo golpeando el bid.

4. Además, **cada trade se puntúa** con 3 sub-scores (0-10) que suman **/30**:
   - **Volumen** (nº de contratos), **Momento** (horario ET: mediodía/apertura/cierre) y
     **Repetición** (cuántas veces se repite el mismo strike).
   - Los trades con puntaje **inusual** (total alto) se **resaltan en amarillo**.
   - Tag **Exceeded Open Interest** cuando el volumen supera el Open Interest.
   - Detalle completo en [SCOREDCARD/Scoredcard.md](../SCOREDCARD/Scoredcard.md).

---

## 4-bis. Sub-agente 2 — Convicción

Mide **qué tan decidido y de calidad es el flujo**. Tres métricas, cada una 0-10, y el promedio
da el score de la categoría:

1. **Spread** — qué tan estrecha está la horquilla bid/ask: `(ask − bid) / mid`.
   <2% → 10 · 2-5% → 7 · 5-10% → 4 · >10% → se aparta (y alerta si el trade supera $1M).
   Estrecho = opción líquida y precio confiable.
2. **Dominancia ASK vs BID** — qué porcentaje del dinero fue a un solo lado.
   80%+ → 10 · 70-79% → 8 · 60-69% → 6 · 55-59% → 4 · 50-54% → 2 · menos → 0.
3. **Fuerza de ejecución** — dónde cayó el precio respecto al spread.
   Sobre el ask / bajo el bid → 10 · en el ask/bid → 8 · cerca del borde → 6 · en el medio → 3.

Detalle completo en [SCOREDCARD/Conviccion.md](SCOREDCARD/Conviccion.md).

## 4-ter. Sub-agente 3 — Inusualidad

Busca transacciones con **perfil institucional** en los últimos 30 días. Cada trade se puntúa en
6 parámetros (0-10) y el promedio da su "puntaje inusual":

1. **Tamaño** — cuánto dinero: >$5M → 10 · $1-5M → 8 · $500k-1M → 7 · $200-500k → 5 · $100k → 3.
2. **Delta** (absoluto) — qué tan direccional: 0.80+ → 10 · 0.70-0.79 → 8 · 0.60-0.69 → 7 · <0.49 → 0.
3. **Theta** (% de decaimiento diario = |theta|/precio) — <1% → 10 · 1-3% → 8 · 3-5% → 5 · >5% → 0.
   Decaimiento bajo = posición para sostener, no lotería.
4. **Gamma** — la zona 0.01-0.08 es la institucional → 10 · 0.08-0.15 → 8 · >0.15 → 4 · <0.01 → 2.
5. **Condición** — single leg → 10 · multileg → 5.
6. **Vencimiento** — 120+ días → 10 · 90d → 8 · 60d → 7 · 30d → 5 · <30d → 2.

Un trade con **≥7/10** se etiqueta como inusual. La categoría es el promedio ponderado por dinero.

Detalle completo en [SCOREDCARD/Inusualidad.md](SCOREDCARD/Inusualidad.md).

## 4-quater. Sub-agente 4 — Acumulación y Rapidez (Estructura)

El único que **no** lee el flujo de trades: analiza la **cadena de opciones completa** (todos los
strikes × todas las expiraciones) para ver *dónde está parado el dinero*.

1. **Valor nocional** (`strike × open interest × 100`, promediado por strike):
   >$500M → 10 · $100-500M → 8 · $50-100M → 6 · $25-50M → 4 · ≤$25M → 2.
   Si el promedio no llega a $25M, se marca **"Baja Liquidez"**.
2. **Dominio de strikes** — de los 5 strikes de mayor nocional, en cuántos un lado (calls o puts)
   tiene ≥60% del nocional: 5 → 10 · 3 → 8 · 1 → 5 · ninguno → 0.
   Mide **dominancia direccional**, no concentración. Además dice si mandan **calls o puts**.
3. **Volumen > Open Interest** (posiciones nuevas): 100% → 10 · ≥50% → 8 · 30-50% → 5 · <30% → 2.

Muestra los **top strikes** y los **vencimientos más relevantes** con su sesgo calls/puts.

Detalle completo en [SCOREDCARD/Acumulacion-Rapidez.md](SCOREDCARD/Acumulacion-Rapidez.md).

## 5. La gráfica "Flujo notable sobre el precio"

Muestra el **precio del subyacente** y encima cada **transacción notable** como un punto:
- **Verde** = al ask (compra agresiva) · **Rojo** = al bid.
- **Tamaño** del punto = notional (cuánto dinero).
- **Hover** = muestra el trade exacto (contrato, lado, premium, tamaño, precio, delta, DTE).

Timeframes disponibles: **1 año (diario)**, **10 días (15 min)**, **5 días (5 min)**.
Hora en **ET** (hora del mercado).

---

## 6. Próximo: detección de acumulación + scoring predictivo (en diseño)

Idea que estamos trabajando: **cuando se acumulan muchos puntos** en poco tiempo (un "racimo" de
trades agresivos en la misma dirección), marcarlo y medir **si después el precio se movió**.

Diseño propuesto (a confirmar):

1. **Detectar racimos (clusters):** ventana deslizante de N minutos; si hay ≥ K trades notables
   con la misma dirección (ask o bid) y un premium acumulado ≥ $X, se marca un **evento de
   acumulación** en la gráfica.
2. **Score del racimo:** combina **cantidad de puntos**, **premium acumulado** y **unidireccionalidad**
   (qué tan del mismo lado están) → un puntaje 0–10 y una **dirección** (alcista/bajista).
3. **Seguimiento (¿pasó algo?):** medir el movimiento del precio en los siguientes T minutos/horas
   tras cada racimo, para ver si el racimo **anticipó** el movimiento. Esto permite, con el tiempo,
   validar qué tan predictivos son los racimos.

> Nota: la parte predictiva idealmente se **valida con histórico** (backtest) antes de confiar en ella.
> No es consejo financiero — es análisis.

---

## 7. Estructura técnica (para quien lea el código)

- `web/lib/marketsnack.ts` — cliente de MarketSnack (flujo, filtros, cookie).
- `web/lib/flow.ts` — clasificación de trades + flags + score de agresividad (funciones puras, con tests).
- `web/lib/occ.ts` — parseo del símbolo OCC (strike, vencimiento, tipo, DTE).
- `web/lib/massive.ts` — cliente de Massive (chain, empresa, barras diarias e intradía).
- `web/app/api/flow` — endpoint SSE del reporte de Agresividad.
- `web/app/api/chain`, `/history`, `/bars`, `/logo` — endpoints de Massive.
- `web/app/page.tsx` — el **dashboard** que compone todo con una búsqueda.
- `web/app/components/` — piezas reutilizables (ScorecardPanel, FlowPriceChart, NotableTable, etc.).

Tests: `npm test` (funciones puras de clasificación y scoring).

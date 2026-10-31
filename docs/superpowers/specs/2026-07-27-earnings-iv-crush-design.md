# Earnings IV-Crush · Venta de Prima — Diseño

**Fecha:** 2026-07-27
**Objetivo:** Convertir a Tito en una herramienta de **venta de prima en earnings** (IV crush).
El agente hoy analiza flujo y dirección; le falta lo que decide un trade de venta de prima:
saber si la **IV está rica** (vale venderla) y sugerir **dónde vender con riesgo definido**.

## La tesis (el edge que perseguimos)

Antes de earnings la IV se infla porque el mercado precia un movimiento grande. Justo después
del reporte la IV **se desploma (crush)**. Si el movimiento real es **menor** que el que la IV
preciaba, quien **vendió prima** gana. El edge NO es "la IV está alta" — es:

> **¿El movimiento IMPLÍCITO (lo que precia la IV hoy) es mayor que el movimiento que la acción
> REALMENTE hace en sus earnings?** Si sí → la IV está rica → vender tiene ventaja.

Hoy el agente muestra el move implícito (rango 1σ) pero **no lo compara contra el histórico**,
que es la pieza que da la ventaja. Eso es lo primero que construimos.

## Principio de diseño

**Aditivo. No se toca `lib/` existente ni las vistas actuales.** Se crean archivos y una vista
nuevos; solo se **lee** (no se modifica) lo que ya existe:

- `ivcontext.ts` → IV actual, **IV Rank**, **skew del frente** ("evento inminente si >+10 pts"),
  régimen (dormida/compresión/normal/expansión/inflada).
- `expectedMove.ts` → σ, bandas 1σ/2σ, `probTouch` por nivel.
- `levels.ts` → soportes/resistencias con `strength` (los muros donde apoyar los strikes).
- `massive.ts` → `fetchOptionChain` (para el straddle ATM) y `fetchDailyBars` (histórico).
- Estimador de earnings del módulo Wheel (`lib/wheel*` — "doble proxy: cadencia de filing + skew")
  para la **fecha** del reporte. Ver [Limitaciones](#datos-y-limitaciones).

Ticker, Ideas, Wheel y Pro **siguen funcionando igual**.

## Módulos nuevos

### 1. `lib/earningsMove.ts` (PURO, tests en `earningsMove.test.ts`) — el corazón

```ts
// Move implícito: del straddle ATM del primer vencimiento POST-earnings.
//   impliedMovePct = (precioCall_ATM + precioPut_ATM) / spot   (aprox. move 1σ del evento)
//   — alternativa robusta: ATM IV * sqrt(DTE/365)
impliedEarningsMove(chain, spot, expiryPostEarnings): { impliedMovePct, atmIv, dte }

// Move histórico: |cambio %| en la sesión de reacción de cada earnings pasado.
//   Para cada fecha de earnings: gap close(prev) -> open o close(prev) -> close(next).
historicalEarningsMoves(bars, earningsDates): {
  moves: number[],        // % abs por evento
  avg, median, max, sample // sample = nº de earnings con dato
}

// La métrica de edge:
richnessRatio = impliedMovePct / histAvgMovePct
// > 1.15  → IV RICA  (vender tiene ventaja)
// 0.85–1.15 → JUSTA (sin edge claro)
// < 0.85  → IV BARATA (no vender / considerar comprar)
earningsRichness(...): {
  impliedMovePct, histAvgMovePct, histMedianPct, histMaxPct,
  richness, sample, verdict: 'rica'|'justa'|'barata'|'sin_datos'
}
```

Reglas: si `sample < 4` → `verdict = 'sin_datos'` (no hay suficiente histórico para confiar,
igual que la salvaguarda de liquidez avisa en vez de inventar).

### 2. `lib/premiumSell.ts` (PURO, tests) — sugeridor de strikes/spreads

Da los puntos concretos para vender, apoyándose en los muros y el move esperado:

```ts
suggestCreditSpreads(chain, spot, levels, expectedMove, opts): {
  putSpread:  Spread | null,   // bull put spread bajo el soporte fuerte, fuera del move
  callSpread: Spread | null,   // bear call spread sobre la resistencia fuerte
  ironCondor: { put: Spread, call: Spread } | null
}
// opts: { targetDelta = 0.15..0.20, minWallStrength = 40, width = 5 }
```

Cada `Spread` trae lo que ya calculé a mano para el trade de BE:
`{ shortStrike, longStrike, credit, maxLoss, breakeven, riskReward, probOTM, width }`.

Lógica de selección:
- **Short strike** = el primer strike con `|delta| ≤ targetDelta` que además caiga **en o más
  allá de un muro fuerte** (`levels.strength ≥ minWallStrength`) y **fuera del move esperado 1σ**.
- **Long strike** = short ∓ `width` (define el riesgo).
- Cálculos: `credit = precioShort − precioLong`, `maxLoss = width·100 − credit·100`,
  `breakeven = short ∓ credit`, `probOTM = 1 − |deltaShort|`.

### 3. `lib/earningsStore.ts` (fs, fase 2) — tracking post-earnings

Extiende la idea de `predictionStore.ts`. Al marcar un setup, guarda la foto (IV implícita,
strikes, crédito). Días después, `reviewEarnings` compara contra las barras reales: ¿crusheó
la IV?, ¿se quedó dentro del move?, ¿P&L del spread? → **base de datos personal del usuario**:
win rate real, crédito promedio capturado, qué niveles de `richness` funcionan.

### 4. `app/api/earnings/route.ts` (SSE) — escáner de la semana

Toma la lista de tickers con earnings próximos (del estimador Wheel + una watchlist base de
liquidez alta), y por cada uno calcula `earningsRichness` + IV Rank + skew del frente + liquidez.
Emite progreso por SSE (igual que `/api/ideas`).

### 5. `app/earnings/page.tsx` + componentes

- **`NavTabs`**: añadir pestaña **"📅 Earnings"** (junto a Ticker/Ideas/Wheel/Time&Sales).
- **`EarningsScanner`**: tabla ranqueada por `richness` — "estos reportan esta semana y su IV
  está más rica para vender".
- **`EarningsCard`** (por ticker): move **implícito vs histórico** (barra comparativa), IV Rank,
  skew del frente, verdict (rica/justa/barata), y los **spreads sugeridos** con crédito/maxLoss/
  BE/R/R/ProbOTM.

## El "Earnings IV-Crush Score" (0–100)

Un score compuesto para ranquear, mezclando lo que ya sabemos que importa:

```
score = 0.45 · richnessScore   (implícito/histórico, el edge principal)
      + 0.25 · ivRankScore     (IV alta vs su propia historia)
      + 0.15 · frontSkewScore  (cuánto crush hay que capturar)
      + 0.15 · liquidezScore   (spread estrecho + OI suficiente)
```

Bandas propuestas (aisladas para ajustarlas de un sitio, como en `validation.ts`).

## Salvaguardas (críticas)

- **Muestra insuficiente:** `sample < 4` earnings → marcar "sin datos históricos, no confiable".
- **Gap risk explícito:** la UI siempre dice que el delta/ProbOTM **subestima** el riesgo de
  earnings (colas gordas) → recomendar **riesgo definido (spreads), no desnudo**.
- **Liquidez:** hereda la salvaguarda existente — si la cadena es ilíquida, no sugerir strikes.
- **No es consejo:** el texto es siempre "el agente ve estos puntos", nunca "vende esto".
  Se mantiene el disclaimer de "no consejo financiero".

## Datos y limitaciones

- **Precio histórico:** ✅ Massive (`fetchDailyBars`) — sobra para el move histórico.
- **Straddle ATM / IV:** ✅ del snapshot de la cadena (plan Options ya lo trae).
- **⚠️ Fechas de earnings:** el punto débil. Reusar el **estimador por doble proxy** del Wheel
  (cadencia de filing + skew) como arranque, y dejar la fuente de fechas **aislada** para poder
  cambiarla por una API de earnings confiable después. Marcar las fechas estimadas como tales.

## Plan por fases

1. **Fase 1 (el edge):** `earningsMove.ts` + `EarningsCard` en la vista Ticker (mostrar
   implícito vs histórico para el ticker abierto). Pequeño, autocontenido, alto valor.
2. **Fase 2:** `premiumSell.ts` (sugeridor de spreads) + integración en la card.
3. **Fase 3:** `app/api/earnings` + `app/earnings/page.tsx` (escáner de la semana + score).
4. **Fase 4:** `earningsStore.ts` (tracking post-earnings → estadística personal).

Todo con tests puros (vitest), aditivo, y por **fork + PR** al repo.

## Riesgo al proyecto

**Bajo.** Archivos nuevos, sin tocar lógica existente; aterriza en el fork del usuario y no
afecta `main` hasta merge. Único costo: superficie nueva que mantener/testear.

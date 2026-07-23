# 07 — GRÁFICA (upgrade visual · rama `feature/chart-upgrade`)

> Fase visual opcional posterior a las Fases 1–4. Estado: **en progreso en rama, sin deploy de producción.** Se itera con vistas previas gratuitas; el merge a `main` (1 deploy = 15 créditos) ocurre solo cuando el look esté aprobado y la gráfica integrada al dashboard.

## Objetivo

Reemplazar la gráfica de Chart.js por un componente propio, más único y animado, sin romper la honestidad del producto (regla de oro #3) ni la restricción de costo cero.

## Decisiones tomadas

- **Sin librería de charts.** Componente SVG a la medida (`public/js/likely-chart.js`). Más ligero que Chart.js/D3, sin CDN, Lighthouse intacto, y como pieza de portafolio pesa más "hecho desde cero". D3 (`d3-force`) se reserva **solo** para los escenarios bayesianos (Entregable 2), donde la física de colisión sí lo justifica.
- **Paleta "Aurora"**: acento teal-verde (`#4fe0b8`) + pronóstico violeta (`#b39dff`) sobre fondo azul-verdoso profundo. Mezcla de las paletas exploradas.
- **Modos Línea y Velas.** Las velas son **OHLC diario real**, agrupando los precios horarios que ya servimos (`/api/history`) por día calendario — sin llamadas extra a la API, honesto (es el dato real bucketeado).
- **Pronóstico** como línea punteada violeta que continúa desde el precio ancla, en ambos modos. Se mantiene visualmente distinto del precio real; ninguna animación sugiere certeza.
- **Interacción**: toggle BTC/ETH, toggle Línea/Velas, encender/apagar pronóstico, cursor con crosshair y tooltip (O·C·H·L en velas).

## Entregables (en orden, cada uno un merge)

| # | Qué | Toca capa de datos | Estado |
|---|---|---|---|
| 1 | Gráfica Aurora (línea/velas/pronóstico/hover) | No | ☑ Integrada al dashboard (`likely-chart.js`); Chart.js eliminado |
| 1b | **Volumen** bajo el precio | Sí — capturar `total_volumes` de CoinGecko (opcional por punto en el contrato de histórico) | ☑ Hecho. `coingecko.mjs` guarda el volumen; `market-contract` lo valida como campo opcional del punto; `features.py` lo acepta e ignora; la gráfica dibuja las barras con toggle. En producción aparece tras la próxima corrida de `refresh-history` (cada 6h) |
| 2 | **Escenarios del modelo** (tablero de Galton en canvas) | Sí — `ml/train.py` expone los residuales | ☑ Hecho. `train.py` guarda `scenarios` en la confianza; `scenario-viz.js` los anima como un tablero de Galton **en canvas** (cada bola cae en el bin de su escenario real → la campana honesta, sin librería). En producción aparecen tras la próxima corrida de entrenamiento |

## Restricción de honestidad (lo que NO se hace)

Se descartaron grafos de clusters, force-graphs de relaciones y gráficas de palabras: LikelyCoin no tiene entidades/relaciones/texto que representar. Pintarlos sería decoración sin dato real, y eso rompe la regla de oro #3. Solo se visualiza lo que el modelo produce.

## Cómo verlo sin gastar créditos

- **Local**: `python3 -m http.server 8894 -d public` → `http://localhost:8894/chart-preview.html`.
- **Deploy preview** (gratis): push de la rama → Netlify genera `deploy-preview-<n>--likelycoin.netlify.app`. La preview pide `/api/latest` y `/api/history` en vivo, con fallback al seed.
- `chart-preview.html` es una página de vista previa, **no** enlazada desde el sitio. Se elimina al integrar la gráfica al dashboard.

## Archivos

- `public/js/likely-chart.js` — el componente (export `initLikelyChart(root, { snapshot, histories })`).
- `public/chart-preview.html` — página de vista previa con datos reales.

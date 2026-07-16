# Crypto Signal Vault — guía para Claude

**Lee `docs/STATUS.md` primero**: es la foto actual del avance (fase activa, tareas, bloqueos, siguiente paso). Después, `docs/00_CONTEXTO.md` y `docs/01_ARQUITECTURA.md`. El plan de fases vive en `docs/05_PLAN_EJECUCION.md`.

**Al final de cada sesión de trabajo**: actualiza `docs/STATUS.md` (sobrescribir la foto) y agrega una entrada a `docs/BITACORA.md` (append-only, más reciente arriba). El estado del proyecto vive en el repo, nunca solo en la memoria local de una máquina.

## Reglas de oro (innegociables)

1. **Costo cero.** Si una solución cuesta dinero, no existe. No re-proponer decisiones descartadas en `docs/00_CONTEXTO.md` §3.
   **Corolario operativo — los deploys son el recurso escaso**: 15 créditos de 300/mes, y si se agotan **el sitio se pausa**. Nada que cambie a diario se commitea al repo (un job diario = 450 créditos/mes): el estado mutable vive en **Netlify Blobs**, el repo solo cambia cuando cambia código. Batchea los pushes a `main`. Lee `docs/06_PRESUPUESTO.md` antes de proponer cualquier flujo automático.
2. **No se abre una fase sin cerrar la anterior** (checklist de `docs/04_QA.md` completo).
3. **La accuracy que se muestra es la que se midió** contra `data/predictions_log.json`. Nunca la esperada ni la del backtest.
4. **Cero jerga financiera en pantalla.** RSI/MACD/etc. viven atrás del telón.
5. **El contrato del artefacto es agnóstico al modelo**: el forecast de 48h se pre-computa en GitHub Actions; Netlify solo lo ancla.
6. **Código y commits en inglés; UI y docs en español; fechas en zona horaria de CDMX.**
7. **Ningún secreto sale de las env vars de Netlify** (`GROQ_API_KEY`, key de CoinGecko).

## Flujo de trabajo

Los subagentes del proyecto están en `.claude/agents/`: orquestador, data-pipe, ml-lab, front-ux, analista-bot, qa-guardian, doc-scribe. Flujo estándar: Orquestador → especialista → QA-Guardian → Doc-Scribe → merge.

Ramas: `main` (producción, auto-deploy Netlify), `dev` (integración), `feature/*`. Los branch deploys y deploy previews son **gratis**: se itera ahí y a `main` se llega ya verificado. Los cambios que solo tocan `docs/` o `*.md` no disparan build (comando `ignore` de `netlify.toml`).

Si cambia la arquitectura o un contrato de datos, se documenta en `docs/` **antes** de implementarse.

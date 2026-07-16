# BITÁCORA — historial de sesiones de trabajo

> Append-only, entradas más recientes arriba. Cada sesión de trabajo agrega una entrada: fecha, qué se hizo, decisiones tomadas. La foto actual vive en [STATUS.md](STATUS.md).

---

## 2026-07-15 — Arranque: scaffold del proyecto (tarea 1.1)

**Hecho:**
- Repo creado en `Some_Scripts_for_chill/crypto-signal-vault` con la estructura completa de `docs/01_ARQUITECTURA.md` §3.
- Handoff maestro (diseño hecho en sesión de claude.ai) dividido en `docs/00–05`.
- 7 subagentes creados en `.claude/agents/` según `docs/03_AGENTES.md`.
- `CLAUDE.md` con las reglas de oro; `README.md` de portafolio; esqueleto de `netlify.toml`, `package.json` y placeholder de `public/` listo para el primer deploy.
- `docs/STATUS.md` + esta bitácora creados para continuidad entre máquinas/sesiones.

**Decisiones:**
- El estado del proyecto vive en el repo (`STATUS.md`/`BITACORA.md`), no en memoria local de una sola máquina.
- Se detectó hueco arquitectónico a resolver en 1.4: el refresh horario de `latest.json` no puede escribir al publish dir → evaluar Netlify Blobs + endpoint vs. refresh solo diario (registrado en STATUS.md).
- Los 7 agentes se usan como roles/checklists, no como pipeline burocrático obligatorio para cada cambio (proteger contra R-03).

**Siguiente:** tareas 1.2/1.3 (Antonio: Netlify + key CoinGecko), luego 1.4 (`predict.mjs` v0).

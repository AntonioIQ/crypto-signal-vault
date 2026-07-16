# 06 — PRESUPUESTO DE NETLIFY (créditos)

> **Léelo antes de proponer cualquier arquitectura que escriba al repo, o de hacer push a `main`.** Este documento es la traducción operativa de la regla de oro «costo cero»: el plan Free de Netlify tiene un límite duro y **cuando se acaban los créditos el sitio se pausa**. No hay recarga en Free. Quedarse sin créditos = LikelyCoin fuera de línea hasta el siguiente ciclo.

## 1. El presupuesto

| | |
|---|---|
| Cuota | **300 créditos/mes**, límite duro, sin auto-recarga |
| Ciclo actual | otorgados 30 jun 2026, expiran **31 jul 2026** |
| Consumo al 16 jul 2026 | 45 créditos (3 production deploys) → **255 restantes** |
| Si se agota | **los proyectos se pausan** (no hay cobro; el sitio deja de servir) |

## 2. Tarifas (documentación oficial de Netlify)

| Concepto | Costo | A nuestra escala |
|---|---|---|
| **Production deploy** | **15 créditos c/u** | **el único costo que importa** |
| Deploy preview / branch deploy | **gratis** | iterar aquí sale $0 |
| Web requests | 2 créditos / 10,000 | ~0 |
| Functions compute | 10 créditos / GB-hora | la horaria consume <1 crédito/mes |
| Web bandwidth | 20 créditos / 1 GB | ~6,600 visitas ≈ 20 créditos |

**Conclusión aritmética: el presupuesto real son ~20 production deploys al mes.** Al 16 jul quedan **~17**. Todo lo demás es ruido.

## 3. Reglas duras

1. **Nada que cambie a diario se commitea al repo.** Un commit a `main` = un deploy = 15 créditos. Un job diario que commitea datos = 30 deploys/mes = **450 créditos contra un presupuesto de 300**. Aritméticamente imposible.
   → **Todo estado mutable vive en Netlify Blobs**, escrito por functions (o por GitHub Actions vía la API de Blobs). El repo solo cambia cuando cambia **código**.
2. **Los cambios solo-documentación no deben deployar.** El comando `ignore` de `netlify.toml` cancela el build cuando el diff toca únicamente `docs/` y `*.md`. Con `STATUS.md` y `BITACORA.md` actualizándose cada sesión, esta regla sola salva varios deploys al mes.
3. **Batchear.** Varios cambios de código en un solo push a `main`. Un push por commit es un lujo de 15 créditos cada uno.
4. **Iterar en ramas.** `feature/*` y `dev` producen branch deploys **gratuitos**. Se prueba ahí; a `main` se llega ya verificado.
5. **Ante la duda, contar deploys.** Antes de proponer un flujo automático, multiplica su frecuencia × 15 créditos × 30 días y compáralo contra 300.

## 4. Implicaciones ya aplicadas

- **Histórico de precios** (Fase 1): no se refresca por commit diario; lo refresca una scheduled function a Blobs. Ver `01_ARQUITECTURA.md`.
- **Artefactos del modelo** (Fase 2, pendiente): el diseño original decía commitear `models/model_YYYYMMDD.json` a diario. **Eso no puede ser**: son 30 deploys/mes. `train.yml` deberá escribir el artefacto a Blobs con `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID`, sin tocar el repo.
- **`predictions_log.json`** (Fase 3, pendiente): mismo caso, mismo destino.

## 5. Monitoreo

Revisar el [balance de créditos](https://app.netlify.com/teams/antapia3003-i3ib1te/billing/general#credit-balance) al cierre de cada fase. Señal de alarma: consumo >150 créditos a mitad de ciclo, o cualquier línea distinta de «Production deploys» que pase de 5 créditos (significaría que algo dispara requests o bandwidth de más).

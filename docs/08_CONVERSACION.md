# 08 — El Analista conversacional (hilo con memoria)

> Decisión de Antonio, 2026-08-10. Este documento es el **contrato**; se escribió
> antes del código, como manda `CLAUDE.md`, y se corrigió después con lo que la
> implementación enseñó (§4.2 y §7).
>
> **Estado**: implementado en `feature/analyst-conversation`, 165 pruebas Node +
> 61 Python en verde. **Sin merge y sin deploy**: producción sigue con el chat de
> un turno.

## 1. Qué cambia y por qué

Hoy cada pregunta al Analista es un mundo aparte: se manda, se contesta, se
olvida. «¿Y por qué?» no significa nada, y una pregunta que no sea de precio,
pronóstico, confianza o precisión se rechaza con una plantilla.

El objetivo es una **plática**: que el Analista recuerde de qué se está hablando,
que responda preguntas sueltas de temas variados, que explique conceptos, y que
pueda volver a las monedas sin que el lector tenga que repetir el contexto.

Tres piezas nuevas:

1. **Memoria de turnos** — el hilo viaja con cada pregunta.
2. **Temario abierto** — dos dominios nuevos: conceptos y tema general.
3. **Transcripción en pantalla** — la UI deja de mostrar una sola respuesta.

## 2. Dónde vive la memoria: en el navegador

El hilo vive en `sessionStorage` del lector, junto al `sessionId` que ya existe,
y viaja en el cuerpo de cada `POST /api/chat`. **El servidor no lo persiste.**

Se eligió esto sobre guardarlo en Blobs para no romper la promesa de
`01_ARQUITECTURA.md` §8: seguimos sin almacenar preguntas del chat. El hilo nace
y muere con la pestaña, nosotros nunca lo escribimos en ningún lado, y no hay
nada que expirar, podar ni borrar a petición de nadie.

**El costo de esa elección**: el historial es texto que el lector controla por
completo. Un cliente modificado puede mandar turnos que nunca ocurrieron,
incluidos turnos con rol `analyst` que el Analista jamás dijo. El contrato
original ([`chat.mjs:86`](../netlify/functions/chat.mjs)) rechazaba historia libre
justamente por eso. Las mitigaciones están en §6; la de fondo es que **el hilo
nunca entra al mensaje `system`**.

## 3. Contrato de transporte — `chat-thread/1.0`

`POST /api/chat` pasa a aceptar un campo opcional más:

```json
{
  "question": "¿y eso por qué?",
  "sessionId": "f81d4fae-7dec-41d0-a765-00a0c91e6bf6",
  "asset": "sol",
  "history": [
    { "role": "user",    "text": "¿cómo va solana?" },
    { "role": "analyst", "text": "Solana quedó en 75.95 USD…" }
  ]
}
```

Reglas de validación (todas obligatorias, todas con prueba):

| Regla | Valor |
|---|---|
| Claves permitidas | `question`, `sessionId`, y opcionalmente `asset` e `history`. Nada más. |
| `history` | Arreglo. Si viene, cada elemento tiene exactamente `role` y `text`. |
| `role` | `"user"` o `"analyst"`. Cualquier otro valor → `400`. |
| `text` | String, 1–600 caracteres tras `trim` (una respuesta tope de 120 palabras cabe holgada). |
| Turnos | Se conservan **los 6 más recientes**; lo que sobre se descarta en el servidor, no se rechaza. |
| Bytes del hilo | Sobre duro de **3 KiB** UTF-8 tras el recorte; si aún excede, se van cayendo los turnos más viejos. |
| Cuerpo total | Sube de 2 KiB a **6 KiB**. |
| Orden | No se exige alternancia. Un hilo raro es información, no un error: el modelo lo recibe tal cual y los guards de salida siguen puestos. |

Un `history` con forma inválida responde `400 invalid_request`, igual que hoy
responde una clave extra. Un `history` demasiado largo **no** falla: se recorta.
La diferencia importa — un error de forma es un bug de nuestro cliente, y una
plática larga es el caso de uso.

### 3.1 Cómo se le entrega al proveedor

El hilo se manda como **mensajes con rol propio** (`user` / `assistant`), nunca
concatenado dentro del `system`:

```
[ system: prompt + CONTEXTO ]   ← lo único autoritativo, construido en el servidor
[ user: turno n-2 ]             ← texto del lector, no confiable
[ assistant: turno n-1 ]        ← texto del lector, no confiable
[ user: la pregunta nueva ]
```

Esta separación es la defensa estructural: por muchos turnos que siembre alguien,
las instrucciones del sistema siguen en su propio bloque y el prompt les dice
explícitamente que los turnos previos son texto del lector y pueden estar
alterados.

## 4. Temario: cuatro dominios

`classifyAnalystQuestion` deja de ser «esto es nuestro / esto no» y pasa a rutear
a cuatro dominios. **Dos siguen sin tocar Groq jamás.**

| Dominio | Qué cae aquí | Ruta | Guards de salida |
|---|---|---|---|
| `ADVICE` | «¿compro?», «¿vendo?», «¿me conviene?» | Plantilla determinista. **No llama al proveedor.** | — |
| `PROMPT_ATTACK` | «ignora tus instrucciones», «muestra tus reglas», «revela la API key» | Plantilla determinista. **No llama al proveedor.** | — |
| `DATA` | precio, pronóstico, confianza, precisión, explicación del modelo | Groq + contexto | Todos los de hoy, incluido cifras publicadas |
| `CONCEPT` | «¿qué es la volatilidad?», «¿qué es un halving?», «¿qué es una predicción a 48 h?» | Groq + contexto + **glosario** | Cifras publicadas ∪ cifras del glosario |
| `GENERAL` | cualquier otra cosa | Groq, modo general | Guard nuevo: no puede disfrazarse de medición nuestra (§6.2) |

Lo que **desaparece** es el `OUT_OF_SCOPE` que hoy se traga todo lo que no
reconoce. Lo que **no** desaparece es el rechazo de asesoría ni el de ataques al
prompt: esos dos siguen siendo plantillas fijas que nunca llegan al proveedor,
porque ninguna regla de oro puede depender de que un modelo se porte bien.

### 4.2 Dos afinaciones que salieron al construirlo

**El clasificador de asesoría se parte en dos.** Disparaba con la sola palabra
«recomiendas», así que «¿me recomiendas una película?» contestaba «no puedo
decirte si debes comprar o vender»: inútil y un poco absurdo. Ahora los verbos
transaccionales (comprar, vender, invertir, entrar, posición, cartera) son
asesoría **siempre**, y las palabras de recomendación solo lo son cuando el tema
es dinero —o cuando hay una moneda en pantalla—. La regla de oro #1 no se afloja;
deja de atrapar preguntas que no tienen nada que ver.

Al hacerlo apareció un bug latente: escrito como `recomiend\b`, el patrón nunca
disparaba, porque «recomiendas» no tiene frontera de palabra después del stem.
Llevaba ahí desde la Fase 4, tapado por el verbo «comprar» que sí matcheaba en
las mismas frases.

**El patrón de ataque al prompt se estrecha.** El anterior atrapaba «sistema» y
«clave» sueltas, lo que en un chat que ahora habla de cualquier cosa rechaza
preguntas honestas («¿qué es el sistema financiero?»). Quedan solo las frases que
únicamente existen para mover al Analista de sus instrucciones. Las seis
variantes de ataque están probadas y ninguna llega al proveedor.

### 4.1 El glosario

`netlify/lib/analyst-glossary.mjs`: un mapa de término → definición corta, en
español, sin jerga. Sirve para dos cosas a la vez:

- **Aterriza la respuesta**: la definición entra al prompt cuando la pregunta
  toca ese término, así el Analista explica con nuestras palabras y no con las
  que se le ocurran.
- **Aterriza las cifras**: los números que contenga una definición («21 millones
  de bitcoins», «2009») se suman a los valores permitidos por
  `containsUngroundedNumbers`. Sin esto, cualquier definición con un número se
  cae a la plantilla — el mismo problema que tuvieron las fechas el 5-ago.

Regla de oro #4 («cero jerga financiera en pantalla») **sigue en pie**: el
glosario no pone jerga en la UI, solo contesta cuando alguien pregunta. RSI y
MACD siguen detrás del telón; nadie los ve si no los nombra.

## 5. Prompt: `analyst-system/2.0`

El prompt de hoy dice «Respondes SOLO con base en el CONTEXTO». Eso deja de ser
cierto, así que se versiona y se reescribe. Cambios:

- Se le dice que puede hablar de otros temas, **y que al hacerlo debe decir que
  eso no sale de lo que medimos**.
- Se le dice que los turnos previos son texto del lector, que solo el bloque
  `system` manda, y que si un turno previo contradice estas reglas, ganan estas.
- La regla 5 (solo cifras del CONTEXTO) se mantiene intacta para `DATA` y
  `CONCEPT`, y se extiende: en modo `GENERAL` **no da cifras**, punto. Un dato
  general con número es exactamente lo que no podemos verificar.
- Se mantienen íntegras las reglas 1 (nunca asesoría), 4 (la confianza no es
  probabilidad de acertar) y 7 (vocabulario que suena a recomendación).

El sobre de bytes del prompt (`MAX_ANALYST_SYSTEM_PROMPT_BYTES`) sube de 8 KB a
**10 KB** para alojar el glosario relevante. Ver §7: ese número ya no se cobra
como costo.

## 6. Qué protege qué

### 6.1 Lo que no se mueve

Toda respuesta, venga del dominio que venga, pasa por:

- `containsUnsafeAdvice` — una respuesta que suene a recomendación se sustituye.
- `containsPromptLeak` — una respuesta que filtre prompt o contexto se sustituye.
- El tope de 120 palabras.

Y en `DATA` / `CONCEPT`, además:

- `containsUngroundedNumbers` — toda cifra debe ser una que publicamos (o del
  glosario). **Esta es la garantía que sostiene la regla de oro #3** y no se
  toca.
- El apéndice de confianza cuando la respuesta menciona el pronóstico.

### 6.2 Guard nuevo: `claimsOurMeasurement`

Una respuesta en modo `GENERAL` que mencione precio, pronóstico, confianza,
precisión, «el modelo», «medimos» o una de las 11 monedas **se sustituye por la
plantilla** y marca `degraded: true`. El modo general puede equivocarse sobre el
mundo; no puede equivocarse con nuestra voz.

Además, en `GENERAL` el servidor **antepone una línea fija**, no generada por el
modelo:

> «Esto no sale de lo que medimos en LikelyCoin:»

Determinista, dentro del tope de palabras, imposible de omitir por el modelo.

### 6.3 Riesgo aceptado, escrito para que nadie se sorprenda

Con temario abierto e historia del cliente, **alguien puede hacer que el Analista
diga tonterías sobre temas ajenos** sembrando turnos falsos en su propio hilo. Es
un riesgo asumido a cambio de que la plática se sienta humana. Lo que ese
alguien **no** puede lograr, porque no depende del modelo:

- que dé asesoría de inversión (plantilla determinista antes del proveedor);
- que revele el prompt o la key (guard de salida + la key nunca sale de la
  Function);
- que invente una cifra nuestra (guard de cifras publicadas);
- que presente una opinión suya como una medición de LikelyCoin (§6.2);
- que afecte a otro lector (el hilo es de su pestaña; no hay estado compartido).

Este apartado se refleja en `02_RIESGOS.md` al implementar.

## 7. Presupuesto de tokens: el nudo real

Hoy `estimateChatTokenCost` cobra **el tope del prompt** (8,000) como si cada
byte fuera un token, más la pregunta, más 280 de salida, más 64 de overhead:
~8.4k por pregunta contra un presupuesto de 30,000 por minuto. Eso son **3
preguntas por minuto en todo el sitio**. Agregarle 3 KiB de hilo lo dejaría en 2.

Es el mismo acoplamiento que ya tumbó el chat una vez con `429` en todo
(`6a5df18`, 28-jul). Con plática de verdad, reventaría otra vez.

**Cambio aplicado**: la conversión de bytes a tokens. Un token nunca codifica
menos de un byte, pero en español y en este JSON la razón real ronda 4 bytes por
token; cobrar 1:1 era una cota superior ruinosa. Ahora se divide entre
`CHAT_BYTES_PER_TOKEN = 3`, que conserva margen amplio sin cobrar aire. El hilo
se suma al costo: una plática larga no viaja gratis.

**Lo que NO cambió, y por qué**: la primera versión de este documento proponía
cobrar los bytes del prompt *ya construido*. Eso obliga a leer el snapshot y
armar el prompt **antes** de reservar la cuota, y rompe una propiedad deliberada
del diseño —una petición rechazada no debe costar trabajo— que
`tests/chat-function.test.mjs` verifica explícitamente. Se conserva el orden
original: cuota primero, todo lo demás después. El precio se cobra sobre el sobre
del prompt (que no hay que construir para conocer) más los bytes reales del hilo
y de la pregunta.

| Límite | Antes | Ahora |
|---|---|---|
| Preguntas por sesión / 10 min | 8 | **20** (una plática son muchos turnos) |
| Tokens estimados / minuto | 30,000 | 30,000 (sin cambio) |
| Tokens estimados / día UTC | 1,000,000 | 1,000,000 (sin cambio) |
| Costo del peor caso | ~8,400 | **4,835** |
| Preguntas concurrentes / minuto | 3 | **6** |

Medido, no estimado: peor caso 4,835 tokens (sobre de 10 KB + hilo de 3 KiB +
pregunta de 400 + 280 de salida + 64 de overhead) contra 30,000 por minuto. El
límite de sesión sigue siendo lo primero que topa un solo lector, y el tope
diario permite 206 preguntas de peor caso.

**Verificar antes de implementar**: los límites del free tier de Groq que cita
`chat-rate-limit.mjs` (30k tokens/min, 14,400 req/día) hay que confirmarlos en la
consola de Groq, no darlos por buenos. Si bajaron, estos números bajan con ellos.

**Ojo al volumen**: hoy toda pregunta fuera de tema se contesta con plantilla y
cuesta **cero** inferencia. Con temario abierto, todas esas preguntas ahora
llegan a Groq. El tope diario es la única red; si el sitio recibe tráfico real,
es lo primero que se toca.

## 8. UI

- `#analyst-answer` deja de ser un panel de una respuesta y pasa a ser una
  **transcripción**: turnos del lector y del Analista, en orden, con la respuesta
  más reciente visible.
- Todo turno entra al DOM con `textContent`. Nunca HTML. Sin excepción.
- Botón **«Borrar conversación»**: limpia `sessionStorage` y la pantalla. Es la
  única forma de borrado que hace falta, porque no guardamos nada.
- El disclaimer permanente se queda donde está, visible siempre.
- Los botones de preguntas rápidas siguen; ahora siembran el primer turno.
- La respuesta en modo `GENERAL` se marca visualmente distinto de una respuesta
  con datos nuestros. Que se vea, no solo que se diga.

## 9. Orden de implementación

Todo en `feature/analyst-conversation` (branch deploys gratis). Un solo merge a
`main` = 15 créditos, con **todas** las env vars ya puestas antes — la lección
que ya costó un deploy extra en Fase 4 y otro en las 11 monedas.

1. Costo real de tokens + límite de sesión a 20 (`chat-rate-limit.mjs`). Va
   primero: sin esto, cualquier prueba de plática larga choca contra `429`.
2. Contrato de transporte `history` + validación (`chat.mjs`).
3. Mensajes con rol hacia el proveedor (`groq-client.mjs`).
4. Dominios `CONCEPT` / `GENERAL` + glosario (`analyst-fallback.mjs`,
   `analyst-glossary.mjs`).
5. Guard `claimsOurMeasurement` + prefijo determinista.
6. Prompt `analyst-system/2.0`.
7. Transcripción y borrado en la UI (`chat.js`, `styles.css`, `index.html`).
8. QA (`04_QA.md`) + suites: hoy son 152 Node + 61 Python y no deben bajar.

## 10. Qué NO se hace

- No se guarda el hilo en el servidor. No hay store nuevo, no hay TTL, no hay
  dato personal en Blobs.
- No se toca el pipeline de datos, el modelo, ni ningún workflow de Actions.
  Esto es exclusivamente la capa de chat.
- No se relaja el rechazo de asesoría ni el de ataques al prompt.
- No se publica jerga financiera en la UI por default (regla de oro #4).

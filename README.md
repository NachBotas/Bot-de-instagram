# 🤖 Bot Setter para Instagram (ManyChat + Claude)

Un setter de ventas que atiende los DMs de Instagram por vos:

- **Entiende el contexto**: recuerda toda la conversación, hace descubrimiento (situación → objetivo → dolor → urgencia) y califica al lead según tus criterios.
- **Entiende audios**: transcribe las notas de voz (Groq / OpenAI / Deepgram) y responde a lo que dijo la persona.
- **Ve imágenes**: si te mandan una captura, la entiende.
- **Agenda la llamada de venta**: ofrece horarios reales y reserva en Cal.com, o manda tu link de Calendly con los datos precargados.
- **Dispara automatizaciones de ManyChat**: recursos gratis, testimonios, videos… lo que tengas armado como Flow.
- **Etiqueta y guarda datos** en ManyChat (tags por etapa + campos con el resumen del lead para el closer).
- **Deriva a un humano** cuando hace falta y se pone en pausa.
- **Escribe como persona**: junta los mensajes que el lead manda seguidos, responde en burbujas cortas y hace un seguimiento si deja de contestar.
- **Detecta cuellos de botella**: te dice después de qué pregunta deja de responder la gente y te propone cómo reescribirla.
- **Varias cuentas y equipo**: manejás varias cuentas de Instagram desde el mismo panel, con usuarios y permisos (administrador, editor, agente).
- **Responde con audio** (opcional): notas de voz con tu voz clonada en ElevenLabs.
- **24/7 en la nube**: el mismo panel, en un servidor, sin depender de tu compu.

```
Instagram DM ──► ManyChat (Default Reply → External Request) ──► este servidor
                                                                     │
          ┌──────────────── transcribe audio / lee imagen ◄──────────┤
          │                                                          │
          └──► Claude (setter) ──► herramientas: guardar lead, ver horarios,
                                     agendar, disparar flow, derivar a humano
                                                                     │
Instagram DM ◄── ManyChat API (sendContent / sendFlow / tags) ◄──────┘
```

---

## ⚡ La forma fácil: la app con panel de control

Una app que corrés en tu compu y manejás con botones, sin tocar código:

- **Interruptor para prender y apagar el bot.** Mientras la compu esté prendida y la app abierta, responde solo.
- **Mi negocio:** pegás tu prompt y la información del negocio.
- **Guion:** elegís las preguntas que hace el bot (en orden, de a una) y el mensaje con la agenda que manda al final. Además, reglas del tipo "si el lead dice esto → hacé esto (y dispará tal automatización)".
- **Versión de Claude:** elegís entre Haiku (el más barato, alcanza para un guion), Sonnet u Opus, con el costo aproximado de cada uno.
- **Automatizaciones:** la app lee tus flows de ManyChat. Navegás carpeta por carpeta y elegís cuáles puede usar el bot y cuándo.
- **Consultas:** cuando el bot no sabe algo, no inventa. Te avisa (en el panel y, si querés, por ManyChat con "Notify Admin"), le dice al lead que lo consulta y sigue la charla. Vos respondés desde el panel y el bot aprende la respuesta para la próxima.
- **Audios:** elegís el servicio de transcripción, con tutorial paso a paso, y lo probás subiendo una nota de voz.
- **Probar el bot:** un chat para hablar con el bot sin mandar nada a Instagram.
- **Conversaciones:** ves qué está hablando con cada lead y lo pausás para responder vos.
- **Análisis:** te muestra en qué pregunta deja de responder la gente.
- **Comportamiento:** horario de atención (fuera de horario los mensajes esperan), demora "humana" al azar, seguimientos, a quién no responderle (tags como `cliente`), qué hacer si algo falla y el **gasto real de Claude** del mes con un tope de aviso.
- **Si algo falla** (Claude sin saldo, ManyChat caído): te avisa en Inicio y en Consultas con un botón **Reintentar**, y al lead le llega un "ya te respondo" para que no quede en visto.
- **Audios:** además de entenderlos, puede **responder con notas de voz** (tu voz clonada en ElevenLabs).
- **Agenda:** conectás Calendly (o Cal.com) para enterarte de quién agendó de verdad; las llamadas agendadas por semana y por mes aparecen en Inicio.
- **Equipo y cuentas:** varias cuentas de Instagram (cada una con su ManyChat, su guion y sus conversaciones) y usuarios con permisos: **administrador** (todo), **editor** (configura sus cuentas) y **agente** (solo consultas y conversaciones).
- **Respaldo:** descargás o restaurás toda la configuración y las conversaciones de una cuenta (sirve para mudarte a la nube).

### Cómo abrirla (zip listo, sin instalar nada)

1. Bajá el zip de tu compu: `Setter-Windows.zip`, `Setter-Mac-Apple.zip` (Mac M1/M2/M3/M4) o `Setter-Mac-Intel.zip`.
2. Descomprimilo y abrí **`Abrir Setter.bat`** (Windows) o **`Abrir Setter.command`** (Mac; la primera vez con clic derecho → Abrir). El `LEEME.txt` del zip lo explica paso a paso.
3. Se abre el panel en tu navegador (<http://localhost:4000>). Seguí los **Primeros pasos** de la pantalla de inicio.

Los zips se generan con `npm run empaquetar` (quedan en `dist-zip/`). Traen el bot compilado y el motor de Node.js oficial adentro.

Desde el código fuente (con Node.js instalado): doble clic en `Iniciar Setter.bat` / `Iniciar Setter.command`, o `npm install` y `npm run app`.

No cierres la ventana negra mientras quieras que el bot responda. El panel solo se puede abrir desde tu compu: a internet solo se expone la dirección que usa ManyChat (vía ngrok), y está protegida con una clave secreta. Tus datos quedan en la carpeta `Setter-datos` de tu usuario, así que al bajar una versión nueva no se pierde nada.

Mientras no crees usuarios, cualquiera que abra el panel en tu compu entra directo. Cuando creás tu usuario en **Equipo y cuentas**, empieza a pedir usuario y contraseña.

### ☁️ Subirlo a la nube (responde 24/7 aunque apagues la compu)

Usamos **Railway** (unos USD 5 por mes; confirmá el precio en su web). Lo hacés una sola vez:

1. Creá una cuenta en <https://railway.com> (podés entrar con GitHub).
2. **New Project → Deploy from GitHub repo** y elegí este repositorio (y la rama donde está esta versión). Railway detecta el `Dockerfile` solo.
3. En **Variables** agregá `PANEL_PASSWORD` con una contraseña larga: es la del usuario `admin` del panel.
4. En **Settings → Volumes** agregá un volumen montado en `/app/data` (ahí se guardan las conversaciones; sin esto se borran en cada actualización).
5. En **Settings → Networking → Generate Domain**: Railway te da una dirección tipo `https://tu-setter.up.railway.app`. Esa es tu panel.
6. Abrí esa dirección, entrá con usuario `admin` y la contraseña del paso 3.
7. **Llevate tu configuración:** en la app de tu compu, **Conexión → Descargar respaldo**; en la nube, **Conexión → Restaurar** (una vez por cuenta). Si no, cargá todo de nuevo desde el panel.
8. **Cambiá la dirección en ManyChat:** en Conexión vas a ver la URL nueva del webhook (con el dominio de Railway). Pegala en el External Request de ManyChat en lugar de la de ngrok.
9. **Apagá el bot en tu compu** (o cerrá la app) para que no respondan los dos.

En la nube no hace falta ngrok, y podés abrir el panel desde cualquier lado, también desde el celular.

> Si preferís configurar todo a mano con `.env` (por ejemplo, para un servidor en la nube), seguí la guía de abajo: los valores del `.env` se usan como punto de partida y después todo se edita desde el panel.

---

## 1. Requisitos

- **ManyChat Pro** con tu Instagram conectado (la API y el "External Request" son de Pro).
- **API key de Claude**: <https://platform.claude.com> → API Keys.
- **API key para audios** (recomendado Groq, que es rápido y barato): <https://console.groq.com>.
- **Agenda**: cuenta de Cal.com (para que el bot agende solo) o tu link de Calendly.
- Un lugar donde correr el servidor 24/7: Railway, Render, Fly.io, un VPS… (abajo hay instrucciones).

## 2. Configurar el bot

```bash
npm install
```

```bash
cp .env.example .env
```

1. Completá `.env` (cada variable está explicada adentro).
2. **Editá `config/negocio.md`**: es lo que el bot sabe de tu negocio (oferta, a quién le sirve, criterios de calificación, preguntas frecuentes, objeciones, tono). Cuanto más concreto, mejor vende. El bot **no inventa** nada que no esté ahí.
3. **Editá `config/automatizaciones.json`**: la lista de Flows de ManyChat que el bot puede disparar y cuándo. El `flow_ns` lo sacás de la URL del flow en ManyChat.

## 3. Probarlo en la terminal (sin ManyChat)

```bash
npm run chat
```

Chateás como si fueras un lead. Con `/audio ruta/al/audio.m4a` simulás una nota de voz, con `/imagen captura.png` una imagen, y con `/lead` ves lo que el bot guardó. Las acciones de ManyChat (tags, flows) se imprimen en gris.

## 4. Conectar ManyChat

### 4.1 API key
ManyChat → **Settings → API** → *Generate your API Key* → pegala en `MANYCHAT_API_KEY`.

### 4.2 Campos y tags (opcional pero recomendado)
En **Settings → Fields** creá estos *User Fields* de tipo **Text** para ver en cada contacto lo que averiguó el bot:

| Campo | Qué guarda |
|---|---|
| `setter_etapa` | conversando / calificado / no_calificado / link_enviado / agendado / humano |
| `setter_resumen` | situación, objetivo, dolor, urgencia… en una línea |
| `setter_email` | email del lead |
| `setter_llamada` | fecha y hora de la llamada agendada |

Los tags (`setter_calificado`, `setter_agendado`, `auto_testimonios`, etc.) se crean solos. Creá el tag **`bot_pausado`**: si se lo ponés a un contacto, el bot deja de responderle (para cuando entrás vos por Live Chat).

### 4.3 El flow que llama al bot
1. **Automation → Default Reply** (Instagram) → configurá la frecuencia en **"Every time"**.
2. En ese flow agregá una acción **External Request**:
   - **Request type**: `POST`
   - **URL**: `https://TU-SERVIDOR/webhook/manychat/<id-de-la-cuenta>` (el panel te la da lista para copiar en **Conexión**)
   - **Headers**: `X-Webhook-Secret` = la clave secreta de esa cuenta (también está en **Conexión**)
   - **Body**: activá **"Add Full Contact Data"** (manda el contacto completo, incluido el último mensaje).
     Si preferís armarlo a mano, usá el botón de variables para insertar el ID del contacto, nombre, usuario de Instagram y "Last Text Input":
     ```json
     { "subscriber_id": "<Contact Id>", "first_name": "<First Name>", "username": "<Instagram Username>", "text": "<Last Text Input>" }
     ```
3. No agregues mensajes después del External Request: el bot responde solo, por la API.
4. Publicá el flow.

> **Comentarios → DM:** si usás disparadores por palabra clave en comentarios o historias, al final de ese flow podés agregar el mismo External Request para que el bot siga la conversación cuando la persona responda.

> **Audios:** cuando alguien manda una nota de voz, ManyChat pone la URL del audio en "Last Text Input" y el bot la descarga y transcribe. Probalo con un audio tuyo la primera vez: si en tu cuenta llega vacío, mandá la URL del adjunto en el campo `attachment_url` del body.

### 4.4 Probar
Mandale un DM a tu cuenta desde otra cuenta de Instagram. En los logs del servidor vas a ver `📩` cuando entra el mensaje y `🔧` cada vez que el bot usa una herramienta.

## 5. Agenda

**Opción A – Cal.com (el bot agenda solo):** creá un tipo de evento en Cal.com, copiá su ID (está en la URL al editarlo) en `CAL_EVENT_TYPE_ID` y creá una API key en *Settings → Developer → API Keys* para `CAL_API_KEY`. El bot ofrece 2-3 horarios, pide el email y reserva. A Cal.com le llegan las notas para el closer (situación, objetivo, dolor, urgencia).

**Opción B – Link (Calendly u otro):** poné tu link en `BOOKING_LINK`. El bot lo manda con nombre, email e ID del contacto precargados. Para que el bot se entere cuando agendan, configurá un webhook de Calendly (`invitee.created`) o Cal.com (`BOOKING_CREATED`) apuntando a:
```
https://TU-SERVIDOR/webhook/agenda/<id-de-la-cuenta>?secret=CLAVE_SECRETA_DE_LA_CUENTA
```
(El panel, en **Agenda**, te da esta dirección lista y conecta Calendly con un botón.)
Cuando entra la reserva, el contacto pasa a `setter_agendado` y, si configuraste `FLOW_BOOKED_NS`, se dispara tu flow de confirmación/recordatorios.

## 6. Publicarlo (deploy)

Ver **"Subirlo a la nube"** más arriba (Railway). Cualquier servicio que corra Docker o Node 20+ sirve: en la nube el panel y los webhooks van por el mismo puerto (`PORT`) y el inicio de sesión es obligatorio (`PANEL_PASSWORD` crea el usuario `admin`). En Railway y Render el modo nube se activa solo; en otros servicios poné `NUBE=true`. Si el servicio no informa su dirección, definí `PUBLIC_BASE_URL`.

Sin Docker: build `npm ci && npm run build`, start `npm start`.

## 7. API de solo lectura

Con `ADMIN_TOKEN` definido (header `Authorization: Bearer <ADMIN_TOKEN>`), para conectar otras herramientas:

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/admin/<cuenta>/leads` | lista de leads con etapa y datos |
| GET | `/admin/<cuenta>/analisis?dias=30` | informe de cuellos de botella (markdown) |

## 8. Cuellos de botella: ¿dónde deja de responder la gente?

El bot registra cada mensaje que manda y si el lead respondió (dentro de las 24 h) o no. El análisis:

1. **Clasifica cada mensaje del bot** según lo que le pedía al lead (saludo, pregunta de objetivo, de presupuesto, propuesta de llamada, pedido de email, link de agenda…). Lo hace Claude y queda guardado, así no se vuelve a pagar por los mismos mensajes.
2. **Calcula el % de abandono por tipo de mensaje**, el embudo (conversó → calificado → agendó) y en qué mensaje se quedó cada lead que dejó de responder.
3. **Te da recomendaciones**: Claude lee ejemplos reales de los mensajes donde la gente se fue (y de los que sí funcionaron), te explica por qué cree que pasa y te propone versiones mejores del mensaje.

```bash
npm run analisis
```

```bash
npm run analisis -- --dias 30
```

El informe se imprime y se guarda en `data/reportes/`. Ejemplo:

```
## Dónde se quedó la gente que dejó de responder
- Pregunta presupuesto: 7 leads (70%)
- Saludo inicial: 2 leads (20%)

| Mensaje del bot      | Enviados | Respondieron | No respondieron | Abandono |
|----------------------|----------|--------------|-----------------|----------|
| Pregunta presupuesto | 12       | 5            | 7               | 58%      |
| Propuesta de llamada | 5        | 4            | 1               | 20%      |
```

También está en el panel, en la sección **Análisis**. Con `--sin-ia` (o `?ia=0`) solo muestra los números, sin pedir recomendaciones.

Necesitás unas cuantas conversaciones para que los números digan algo: los tipos de mensaje con menos de 5 casos se marcan con ⚠️.

## 9. Ajustes útiles

- **Personalidad, método y reglas** del setter: `src/agent/prompt.ts`.
- **Velocidad vs. calidad**: `CLAUDE_EFFORT=low` es rápido y alcanza para chat; subilo a `medium` si querés respuestas más elaboradas.
- **Seguimientos**: `FOLLOWUP_ENABLED`, `FOLLOWUP_AFTER_HOURS`, `FOLLOWUP_MAX`. Solo se mandan dentro de las 24 h desde el último mensaje del lead (regla de Instagram).
- **Avisos al equipo**: `HANDOFF_WEBHOOK_URL` recibe un POST cada vez que el bot deriva a un humano (conectalo a Slack/WhatsApp con Make, Zapier o n8n).

## Desarrollo

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

Estructura:

```
config/negocio.md             ← info de tu negocio (editar)
config/automatizaciones.json  ← flows de ManyChat que puede disparar (editar)
panel/                        ← la interfaz del panel de control (HTML + JS)
src/server.ts                 ← arranque: webhooks públicos + panel (compu o nube)
src/panel.ts                  ← API del panel: sesión, permisos, cuentas, equipo
src/plataforma.ts             ← varias cuentas, túnel ngrok, dirección pública
src/runtime.ts                ← una cuenta: ajustes en caliente, errores, gasto, voz, respaldo
src/usuarios.ts               ← equipo, contraseñas y sesiones
src/settings.ts               ← ajustes de cada cuenta (data/cuentas/<id>/ajustes.json)
src/consultas.ts              ← bandeja: no supo responder, pidió una persona, errores
src/gasto.ts                  ← contador de gasto real de Claude
src/horario.ts                ← horario de atención
src/engine.ts                 ← junta mensajes, procesa audios/imágenes, envía respuestas, seguimientos
src/agent/setter.ts           ← loop con Claude
src/agent/prompt.ts           ← personalidad y método de venta
src/agent/tools.ts            ← herramientas (lead, agenda, flows, derivar)
src/analytics/                ← análisis de cuellos de botella
src/integrations/             ← ManyChat, Cal.com, transcripción, descarga de adjuntos
```

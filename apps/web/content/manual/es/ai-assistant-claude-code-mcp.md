---
title: Claude Code y MCP
order: 1
category: ai-assistant
subcategory: claude-code-mcp
---

# Claude Code y MCP

lazyit se puede usar desde **Claude Code** y desde cualquier otra app de IA que hable el **Model Context
Protocol (MCP)** — Cursor, VS Code, OpenAI Codex y otras. La app se conecta a tu instancia y trabaja
**como vos**: ve lo que tu rol puede ver, solo puede hacer lo que tu rol permite, y cada cambio que hace
queda registrado a tu nombre, indicando que se hizo a través de una app de IA.

El **plugin de Claude Code** instala dos piezas de una vez:

- **El servidor MCP** — las herramientas de lazyit (buscar activos, usuarios, accesos, artículos; crear
  y modificar registros) expuestas a la app.
- **La skill de lazyit** — una guía corta que le enseña a Claude qué es lazyit y cómo usarlo bien.

## Antes de empezar

- Un administrador tiene que activar **Agentes de IA externos (MCP)** en **Configuración → IA**. Es
  independiente del chat integrado: funciona sin ningún proveedor de IA configurado.
- Tu rol necesita **Conectar agentes de IA externos (MCP)** (`ai:connect`). Administradores y Miembros
  lo tienen por defecto.

Abrí el **menú de usuario** (tu avatar, arriba a la derecha) → **IA y apps conectadas** (`/account/ai`).
La página dice cómo se conectan las apps en tu instancia y muestra los comandos exactos para copiar.

## Antes de conectar: en qué confiás

Por MCP, **lazyit no muestra tarjetas de aprobación**. La app, y el modelo detrás de ella, deciden qué
llamar — y **la app decide si te pregunta antes**. Leé esto antes de conectar una:

- **Tus datos van al proveedor de IA de la app.** Todo lo que la app lee de lazyit — cualquier registro
  que podés ver — se envía al modelo que usa la app, bajo las condiciones de tu propia cuenta con él.
  lazyit no tiene nada que decir sobre la retención o el entrenamiento de ese proveedor.
- **Mantené activas las confirmaciones de la app.** La mayoría de los clientes preguntan antes de
  ejecutar una herramienta que cambia datos; lazyit marca honestamente sus herramientas como de lectura,
  de cambio o destructivas para que puedan hacerlo. Si desactivás eso (un modo "auto-aprobar" o "yolo"),
  un cambio se ejecuta en cuanto el modelo decide hacerlo.
- **Un texto en lazyit puede intentar manejar al modelo.** Un artículo, una nota o una descripción que
  escribió otra persona puede traer instrucciones dirigidas a una IA. Combinado con otros servidores MCP
  en la misma sesión que puedan **abrir páginas web, mandar correos o publicar mensajes**, esa
  instrucción podría hacer que el modelo mande tus datos de lazyit a otro lado. No combines lazyit con
  esos servidores en una sesión donde no revisás cada llamada.
- **Otorgá el acceso mínimo.** Elegí **Solo lectura** salvo que necesites que la app cambie cosas. Las
  **Acciones de administración** — roles, accesos, inicio de sesión y otros cambios sensibles — nunca
  vienen preseleccionadas y piden tu contraseña; otorgalas solo para una tarea que las necesite, y
  después revocá.
- **Revocá lo que no uses**, en [Apps conectadas](/help/ai-assistant-connected-apps).

Una cuenta de servicio conectada por MCP no tiene a nadie a quien preguntarle; su administrador la acota
con el [acceso a IA y un tope de escrituras](/help/ai-assistant-setup#cuentas-de-servicio).

## Cómo se conectan las apps: OAuth o tokens personales

lazyit elige el método según la dirección pública configurada de la instancia (`WEB_ORIGIN`); la página
muestra cuál corresponde.

| La instancia está configurada con | Las apps se conectan con | Qué hacés |
| --- | --- | --- |
| una dirección **HTTPS** | **Inicio de sesión OAuth** | La app abre lazyit en tu navegador; la aprobás en una pantalla de consentimiento. No hay token para copiar. |
| ninguna dirección HTTPS (por ejemplo **HTTP plano**, modo LAN) | **Tokens personales** | [Creás un token](/help/ai-assistant-connected-apps#tokens-personales) y se lo das a la app. |

**¿Por qué no hay OAuth en HTTP plano?** OAuth manda códigos y tokens de un solo uso entre tu navegador,
la app y lazyit. Sin cifrar, cualquiera en la red podría leerlos, y las apps de IA se niegan a iniciar
sesión por HTTP plano. Si la página dice que estás en HTTPS pero igual usa tokens personales, la
instancia no está configurada con su dirección HTTPS — un administrador configura `WEB_ORIGIN`; mirá
[Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls).

**Los conectores en la nube** (claude.ai, conectores de Claude Desktop, ChatGPT) se conectan desde los
servidores del proveedor, así que solo funcionan si tu instancia es **accesible desde internet por
HTTPS** con un certificado de confianza pública. Las apps de escritorio y de línea de comandos — Claude
Code, Cursor, VS Code — solo necesitan llegar a lazyit desde tu computadora.

## Instalar en Claude Code (instancias HTTPS)

1. Copiá los dos comandos de **IA y apps conectadas** y ejecutalos en una terminal. Se ven así:

   ```
   claude plugin marketplace add https://lazyit.example.com/api/ai/claude-code/marketplace.json
   claude plugin install lazyit@lazyit-lazyit-example-com
   ```

   El marketplace lleva el nombre de la dirección de tu instancia, así que podés tener varias instancias
   lado a lado. Los comandos siempre usan la dirección **configurada** de la instancia: si abriste
   lazyit en otra (un nombre interno o una IP), la página te avisa y los muestra para revisar.
2. Iniciá Claude Code, ejecutá `/mcp`, elegí **lazyit** e iniciá sesión. Tu navegador abre la
   [pantalla de consentimiento](#la-pantalla-de-consentimiento).
3. **Las actualizaciones no son automáticas por defecto.** Abrí `/plugin` en Claude Code →
   **Marketplaces**, elegí tu marketplace de lazyit y activá la actualización automática.

**En una instancia `localhost`** (`localhost`, `127.0.0.1`, `::1`), Claude Code rechaza un marketplace en
una dirección de loopback, así que la página oculta esos comandos y empieza por la
[descarga](#instalar-desde-una-descarga-cualquier-instancia).

**Autoridad certificante interna.** Si el certificado de la instancia lo emite una CA de tu empresa,
Claude Code (y otras apps basadas en Node.js) tienen que confiar en ella antes de arrancar:

```
export NODE_EXTRA_CA_CERTS=/ruta/a/ca-interna.pem
```

## Instalar desde una descarga (cualquier instancia)

La única forma en una instancia HTTP plana, y una alternativa en HTTPS.

1. En **IA y apps conectadas**, hacé clic en **Descargar plugin (.zip)**. Está armado para tu instancia
   y **no contiene ningún token**.
2. Descomprimilo en tu carpeta de skills de Claude Code:

   ```
   mkdir -p ~/.claude/skills/lazyit
   unzip -o lazyit-plugin.zip -d ~/.claude/skills/lazyit
   ```

   Claude Code lo carga en tu **próxima sesión** como el plugin `lazyit@skills-dir`. Para probarlo solo
   por una sesión, ejecutá `claude --plugin-dir ./lazyit-plugin.zip`. Para actualizarlo, descargalo de
   nuevo y descomprimilo sobre la misma carpeta.
3. Conectá:
   - **HTTPS:** iniciá Claude Code y ejecutá `/mcp` para iniciar sesión.
   - **HTTP plano:** primero [creá un token personal](/help/ai-assistant-connected-apps#tokens-personales).
     Claude Code te lo pide al activar el plugin y lo guarda en el llavero de tu sistema — nunca en los
     archivos del plugin.

## Otros clientes MCP

La tarjeta **Otros clientes MCP** muestra la dirección del servidor MCP (`https://<tu-instancia>/mcp`)
y configuración lista para **Claude Code** (solo el servidor, sin la skill), **Cursor**, **VS Code** y
cualquier otro cliente:

- **HTTPS:** solo hace falta la dirección. El cliente descubre el inicio de sesión de lazyit y abre la
  pantalla de consentimiento en tu navegador.
- **HTTP plano:** el cliente manda tu token personal en una cabecera `Authorization: Bearer …`.
  Reemplazá el marcador `YOUR_PERSONAL_TOKEN` por tu token; el fragmento de VS Code lo pide al arrancar
  el servidor, así que nunca queda escrito en el archivo.

Nunca pongas un token en la dirección (`?token=…`): lazyit lo rechaza y **revoca ese token en el acto**.
Dejá fuera de los repositorios compartidos los archivos de configuración que tengan un token.

## La pantalla de consentimiento

Cuando una app inicia sesión con OAuth, lazyit muestra una pantalla de consentimiento antes de otorgar
nada:

- **El nombre de la app** — **Verificada** cuando la app se identifica con una dirección publicada que
  está en la lista de apps permitidas de tu instancia (Claude Code lo está de entrada); si no, **Sin
  verificar**, y el nombre es solo lo que la app dice de sí misma.
- **El dominio de la app** — para una app que publica sus datos en una dirección web (Claude Code lo
  hace, en `claude.ai`), lazyit los busca ahí y muestra **Dominio: claude.ai**. Una app puede mostrar un
  dominio y seguir **Sin verificar**: probó de dónde vienen sus datos, pero no está en tu lista.
- **Adónde vas a volver** — la dirección donde la app recibe el inicio de sesión, en letra grande.
  **Esta es la señal de confianza real**: para una app de escritorio suele ser `localhost` o
  `127.0.0.1` (tu propia computadora).
- **La cuenta con la que actúa**, y **qué puede hacer** — **Solo lectura** o **Lectura y escritura**
  (preseleccionada cuando la app la pidió).
- **Acciones de administración**, solo si la app las pidió. Nunca vienen preseleccionadas; marcarlas
  pide tu contraseña. Después de cinco contraseñas incorrectas lazyit te hace esperar antes de reintentar
  ("Demasiados intentos"), y esa espera es compartida con las confirmaciones con contraseña del chat de
  IA.

Elegí **Permitir acceso** o **Denegar**. Para una app **sin verificar**, lazyit te pide confirmar una
segunda vez: seguí solo si iniciaste la conexión vos, recién, y reconocés adónde te manda (y su dominio).
lazyit nunca te redirige sin un clic, y pregunta cada vez.

Si la pantalla dice que la app **no está permitida**, o que pidió una dirección que no registró, lazyit
se detiene y no te manda a ningún lado — mirá
[Resolución de problemas](/help/ai-assistant-troubleshooting#la-pantalla-de-consentimiento-dice-que-la-app-no-está-permitida).

### Cómo reconoce lazyit una app

Algunas apps — Claude Code entre ellas — se identifican con una **dirección HTTPS** donde publican su
nombre y sus direcciones de inicio de sesión. lazyit lee esa descripción al conectarte y la recuerda
hasta un día, así los datos vienen del publicador y no de la app. Solo la lee desde direcciones públicas
de internet, no sigue redirecciones, y rechaza una descripción que no coincide con su dirección.

- **¿Tu servidor de lazyit no tiene acceso a internet?** Claude Code igual se conecta: lazyit trae una
  copia de la descripción de Claude Code y la usa cuando no puede obtener la real. Otras apps que se
  identifican así necesitan que lazyit llegue a su dirección.
- **Las apps que se registran solas** (la mayoría de los demás clientes MCP) no necesitan esto.

La lista de apps permitidas del administrador en **Configuración → IA** se aplica en los dos casos.

## Qué pasa después

- La primera vez que una app usa una conexión nueva, lazyit te avisa (y te manda un correo, si el correo
  está configurado), con un enlace a **IA y apps conectadas** donde podés
  [revocarla](/help/ai-assistant-connected-apps).
- La app renueva su inicio de sesión sola. Si pasa 30 días sin usarse, te pide iniciar sesión de nuevo.
- ¿Algo no funciona? Mirá [Resolución de problemas](/help/ai-assistant-troubleshooting#agentes-de-ia-externos-mcp).

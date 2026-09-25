---
title: Claude Code y MCP
order: 1
category: ai-assistant
subcategory: claude-code-mcp
---

# Claude Code y MCP

lazyit se puede usar desde **Claude Code** y desde cualquier otra app de IA que hable el **Model Context
Protocol (MCP)**: Cursor, VS Code y otras. La app se conecta a tu instancia de lazyit y trabaja **en tu
nombre**: ve lo que tu rol puede ver y solo puede hacer lo que tu rol permite. Cada cambio que hace
queda registrado a tu nombre, como cualquier otro.

Hay dos piezas, y el **plugin de Claude Code** instala ambas a la vez:

- **El servidor MCP**: las herramientas de lazyit (consultar activos, usuarios, accesos, artículos;
  crear y modificar registros) disponibles para la app de IA.
- **El skill de lazyit**: una guía breve que le enseña a Claude qué es lazyit y cómo usarlo bien.

## Antes de empezar

- Un administrador debe activar el **servidor MCP** en **Ajustes → IA**. Es independiente del chat
  integrado: MCP funciona aunque no haya ningún proveedor de IA configurado.
- Tu rol necesita el permiso **Conectar agentes de IA externos (MCP)** (`ai:connect`). Los administradores y los miembros
  lo tienen por defecto.

Abre el **menú de usuario** (tu avatar, arriba a la derecha) y elige **IA y apps conectadas**. La página
está en `/account/ai`. Te indica, para tu instancia, de qué forma se conectan las apps y por qué, y luego
muestra los comandos exactos para copiar.

## Cómo se conectan las apps: OAuth o tokens personales

lazyit elige el método según cómo se sirve la instancia. No lo eliges tú; la página muestra cuál aplica.

| Tu instancia se sirve por | Las apps se conectan con | Qué haces |
| --- | --- | --- |
| **HTTPS** | **Inicio de sesión OAuth** | La app abre lazyit en tu navegador y la apruebas en una pantalla de consentimiento. No hay token que copiar. |
| **HTTP sin cifrar** (modo LAN) | **Tokens personales** | Creas un token en lazyit y se lo das a la app. |

**¿Por qué no hay OAuth por HTTP?** El inicio de sesión OAuth envía códigos de un solo uso y tokens entre
tu navegador, la app y lazyit. Por HTTP sin cifrar cualquiera en la red podría leerlos, y las apps de IA
se niegan a iniciar sesión por HTTP. Por eso, en una instancia LAN, lazyit desactiva OAuth y ofrece
tokens personales. Si la página dice que estás en HTTPS pero igualmente usa tokens personales, la
instancia no está configurada con su dirección HTTPS: la define un administrador (`WEB_ORIGIN`); consulta
[Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls).

Los **conectores en la nube** (claude.ai, ChatGPT) se conectan desde los servidores del proveedor, no
desde tu equipo. Solo funcionan si tu instancia de lazyit es **accesible desde internet por HTTPS**. Las
apps de escritorio y de línea de comandos —Claude Code, Cursor, VS Code— solo necesitan llegar a lazyit
desde tu máquina, así que también funcionan en una red interna.

## Instalar en Claude Code (instancias HTTPS)

1. Copia los dos comandos de **IA y apps conectadas** y ejecútalos en una terminal. Se ven así:

   ```
   claude plugin marketplace add https://lazyit.example.com/api/ai/claude-code/marketplace.json
   claude plugin install lazyit@lazyit-lazyit-example-com
   ```

   El marketplace lleva el nombre de la dirección de tu instancia, así que puedes agregar varias
   instancias de lazyit a la vez. Los comandos siempre usan la dirección **configurada** de la
   instancia: si abriste lazyit en otra (un nombre interno o una IP), la página te avisa y muestra los
   comandos para revisarlos en lugar de listos para copiar.
2. Inicia Claude Code, ejecuta `/mcp`, elige **lazyit** e inicia sesión. Tu navegador abre la pantalla de
   consentimiento de lazyit (ver más abajo).
3. **Las actualizaciones no son automáticas por defecto.** Para recibir nuevas versiones del skill, abre
   `/plugin` en Claude Code, ve a **Marketplaces**, selecciona tu marketplace de lazyit y activa la
   actualización automática.

**Autoridad de certificación interna.** Si el certificado HTTPS de tu instancia lo emite una CA de tu
empresa, hay que indicarle a Claude Code (y a otras apps basadas en Node.js) que confíe en ella antes de
iniciarlas:

```
export NODE_EXTRA_CA_CERTS=/ruta/a/ca-interna.pem
```

## Instalar desde una descarga (cualquier instancia)

Es la única vía en una instancia HTTP sin cifrar, y una alternativa en HTTPS.

1. En **IA y apps conectadas**, haz clic en **Descargar plugin (.zip)**. El archivo está generado para tu
   instancia y **no contiene ningún token**.
2. Descomprímelo en tu carpeta de skills de Claude Code:

   ```
   mkdir -p ~/.claude/skills/lazyit
   unzip -o lazyit-plugin.zip -d ~/.claude/skills/lazyit
   ```

   Claude Code lo detecta en tu **próxima sesión** como el plugin `lazyit@skills-dir`, sin marketplace
   ni paso de instalación. Para probarlo en una sola sesión sin instalarlo, ejecuta
   `claude --plugin-dir ./lazyit-plugin.zip`. Para actualizarlo, vuelve a descargar el plugin y
   descomprímelo sobre la misma carpeta.
3. Conéctate:
   - **HTTPS:** inicia Claude Code y ejecuta `/mcp` para iniciar sesión.
   - **HTTP sin cifrar:** primero [crea un token personal](/help/ai-assistant-connected-apps). Claude Code
     te lo pide al activar el plugin y lo guarda en el llavero de tu sistema, nunca en los archivos del
     plugin.

## Otros clientes MCP

La tarjeta **Otros clientes MCP** muestra la dirección del servidor MCP (`https://<tu-instancia>/mcp`) y
la configuración lista para **Claude Code** (solo el servidor, sin el skill), **Cursor**, **VS Code** y
cualquier otro cliente:

- **HTTPS:** solo hace falta la dirección. El cliente descubre por sí mismo el inicio de sesión de lazyit
  y abre la pantalla de consentimiento en tu navegador.
- **HTTP sin cifrar:** el cliente envía tu token personal en una cabecera `Authorization: Bearer …`. Los
  fragmentos llevan el marcador `YOUR_PERSONAL_TOKEN`: reemplázalo por tu token. El de VS Code pide el
  token al iniciar el servidor, así que nunca queda escrito en el archivo.

Los fragmentos nunca contienen un token real. No subas a repositorios compartidos archivos de
configuración que contengan un token.

## La pantalla de consentimiento

Cuando una app inicia sesión con OAuth, lazyit muestra una pantalla de consentimiento antes de conceder
nada. Muestra:

- **El nombre de la app**: marcada como **Verificada** cuando la app está en la lista de apps conocidas
  de tu instancia y lazyit la confirmó por la dirección en la que se publica a sí misma (Claude Code lo
  está de serie), o **Sin verificar** cuando el nombre es solo lo que la app dice de sí misma.
- **A dónde vuelves**: la dirección en la que la app recibe su inicio de sesión, en letra grande. Es la
  señal de confianza real: para una app de escritorio suele ser `localhost` o `127.0.0.1` (tu propio
  equipo). Un sitio web que mencione la app se muestra solo como texto no comprobado.
- **La cuenta en cuyo nombre actúa** y **qué puede hacer**: **Solo lectura** o **Lectura y escritura**
  (preseleccionada cuando la app la pide).
- **Acciones de administración**, solo si la app las pidió. Nunca vienen marcadas, y al marcarlas se
  pide tu contraseña.

Elige **Permitir acceso** o **Denegar**. Para una app **sin verificar**, lazyit te pide confirmar una
segunda vez: continúa solo si iniciaste la conexión tú mismo, hace un momento, y reconoces a dónde te
envía. lazyit nunca te reenvía a una app sin un clic, y pregunta cada vez: las aprobaciones no se
recuerdan.

Si la pantalla dice que la app **no está permitida**, o que pidió una dirección que no registró, lazyit
se detiene ahí y no te envía a ningún sitio. Inicia la conexión de nuevo desde la app o consulta a tu
administrador: él decide qué apps pueden conectarse en **Ajustes → IA**.

### Cómo reconoce lazyit una app

Algunas apps —Claude Code entre ellas— se identifican con una **dirección HTTPS** en la que publican una
breve descripción de sí mismas: su nombre y las direcciones en las que inician sesión. lazyit lee esa
descripción de internet cuando te conectas y la recuerda un tiempo (hasta un día), así que el nombre de la
app y sus direcciones de inicio de sesión vienen de quien la publica y no de la propia app. lazyit solo la
lee desde direcciones públicas de internet —nunca desde tu red interna—, no sigue redirecciones y rechaza
una descripción que no coincide con la dirección de la que vino.

- **¿Tu servidor de lazyit no tiene acceso a internet?** Claude Code se conecta igual: lazyit incluye una
  copia de la descripción de Claude Code y la usa siempre que no puede obtener la real. Otras apps que se
  identifican así necesitan que lazyit llegue a su dirección; si no puede, la pantalla de consentimiento
  dice que la app no está permitida.
- **Las apps que se registran solas** (la mayoría de los demás clientes MCP) funcionan como antes.
- La lista de apps permitidas de tu administrador en **Ajustes → IA** se aplica en ambos casos.

## Qué pasa después

- La primera vez que una app usa su nueva conexión, lazyit te envía una notificación (y un correo si el
  correo está configurado) para que una conexión inesperada nunca pase desapercibida. Enlaza a **IA y
  apps conectadas**, donde puedes [revocarla](/help/ai-assistant-connected-apps).
- Cada cambio que hace la app queda registrado a tu nombre, indicando que llegó a través de una app de
  IA.

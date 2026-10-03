---
title: Asistente de IA — configuración
order: 1
category: ai-assistant
subcategory: setup
---

# Asistente de IA — configuración

Todo lo relacionado con IA se configura en **Configuración → IA**, que requiere el permiso **Configurar
la instancia**. La página tiene cinco tarjetas:

1. **El proveedor** — un asistente de configuración mientras el asistente está desactivado, y el editor
   **Proveedor y modelo** una vez activo.
2. **Comportamiento y límites** — retención, presupuestos e instrucciones del asistente.
3. **Búsqueda web** — desactivada por defecto.
4. **Agentes de IA externos (MCP)** — su propio interruptor, el endpoint y los clientes permitidos.
5. **Desactivar el asistente de IA** — visible mientras está activo.

Al lado de cada ajuste, el **?** lo explica (pasá el mouse por encima, o hacé clic, tocá o apretá Enter
para dejarlo abierto; Escape lo cierra). La mayoría de las ayudas terminan con **Más información en el
Manual**, que abre la sección correspondiente de esta página; **Guía de configuración**, arriba en
Configuración → IA, también abre esta página.

Antes de activar nada, leé [Qué sale de tu servidor](/help/ai-assistant-overview#qué-sale-de-tu-servidor).

## Antes de empezar: `AI_SECRET_KEY`

Las claves de API de los proveedores se guardan cifradas con una clave propia: la variable de entorno
`AI_SECRET_KEY` del servicio de la API. Una instalación nueva y `start.sh --reconfigure` la escriben por
vos. Para agregarla a mano, generala con `openssl rand -hex 32`, configurala, reiniciá la API y
respaldala junto con el resto de tu archivo de entorno.

Mientras no esté, Configuración → IA lo avisa arriba de todo, no se puede guardar ninguna clave de API
y solo se puede usar un servidor compatible con OpenAI que no pida clave. MCP no la necesita. Perderla
solo implica volver a escribir la clave del proveedor.

## El asistente de configuración

Mientras el asistente está desactivado, Configuración → IA te guía en cinco pasos. Cada paso guarda lo
que ingresaste (todavía desactivado), así que podés parar y volver — el asistente retoma donde lo
dejaste.

1. **Proveedor** — Anthropic, OpenAI, Google Gemini o **compatible con OpenAI**: cualquier servidor que
   hable la API de OpenAI, como un modelo propio o un gateway.
2. **Credenciales** — la clave de API del proveedor. Se guarda cifrada y **no se vuelve a mostrar**, ni
   siquiera a los administradores. Para un servidor compatible con OpenAI también indicás su **URL
   base** (suele terminar en `/v1`); mirá [Servidores en red privada](#servidores-en-red-privada).
3. **Modelo** — elegí una sugerencia o escribí cualquier id de modelo que acepte tu proveedor, y
   opcionalmente el **esfuerzo de razonamiento** (más esfuerzo responde mejor pedidos difíciles, pero es
   más lento y usa más tokens). Para un servidor compatible con OpenAI también podés fijar una
   **temperatura** entre 0 y 2.
4. **Prueba** — lazyit comprueba que el proveedor acepte la clave, conozca el modelo y que el modelo
   pueda **llamar herramientas**. Sin eso el asistente no funciona, así que no podés seguir hasta que la
   prueba pase. Si falla, dice por qué; mirá
   [Resolución de problemas](/help/ai-assistant-troubleshooting#la-prueba-de-conexión-falla).
5. **Activar** — revisá qué sale de tu servidor, confirmá que podés enviárselo al proveedor y elegí
   **Activar el asistente de IA**. La página se recarga; quienes tienen **Usar el asistente de IA** ven
   el chat en la barra superior en menos de un minuto, o al recargar.

lazyit vuelve a probar la conexión en el momento de activarlo: si falla ahí, no cambia nada.

## Cambiar el proveedor, el modelo o la clave

Con el asistente activo, **Proveedor y modelo** reemplaza al asistente de configuración. Cambiá de
proveedor, de modelo o de ajustes extra, o escribí una clave nueva para reemplazar la guardada; **Probar
esta configuración** prueba tus cambios antes. Todo cambio de conexión se vuelve a probar al guardar —
si la prueba falla, no se guarda nada y el asistente sigue funcionando con la configuración anterior.

- Cambiar el **proveedor** o la **URL base** descarta la clave guardada (una clave pertenece a un único
  destino), así que escribí la clave del destino nuevo en el mismo guardado.
- Cambiar el **proveedor** deja de solo lectura todos los chats existentes. Cambiar el **modelo por
  defecto** deja de solo lectura solo los chats que usaban el modelo por defecto; los chats donde la
  persona eligió un modelo siguen funcionando. Para seguir, se empieza un chat nuevo.

## Servidores en red privada

Para un modelo propio, elegí **compatible con OpenAI** e indicá su dirección en tu red. Activá
**Servidor en una red privada** para permitir una dirección privada (10.x, 172.16–31.x, 192.168.x, o un
nombre interno que resuelva a una); solo así se acepta una dirección `http://` plana — y en ese caso la
clave y los prompts cruzan tu red sin cifrar.

Siempre se rechazan: `localhost` y demás direcciones de loopback (desde el contenedor de la API apuntan
al propio contenedor), las direcciones link-local y las de metadatos de la nube. Para un modelo en el
mismo host de Docker, mirá la nota sobre `host.docker.internal` en el runbook de despliegue. La URL base
no puede llevar usuario, contraseña, query string ni fragmento — la clave va en el campo de la clave de
API.

## Comportamiento y límites

Se aplican a todas las conversaciones, con el asistente activo o no, y rigen desde el siguiente pedido.

| Ajuste | Por defecto | Qué hace |
| --- | --- | --- |
| Guardar las conversaciones durante | 90 días | Las más viejas se borran automáticamente (7–3650 días). El registro de acciones de IA se conserva igual. |
| Las tarjetas de aprobación vencen a los | 30 minutos | Un cambio propuesto — o un formulario de preguntas — que nadie responde a tiempo ya no se puede aprobar. |
| Presupuesto diario de tokens por persona | 2.000.000 | Lo máximo que una persona o cuenta de servicio puede usar en 24 horas. Desactivalo para no tener presupuesto. |
| Largo máximo de respuesta | — | La respuesta individual más larga. |
| Pasos máximos por pedido | — | Cuántas llamadas a herramientas puede encadenar un pedido. |
| Tamaño máximo de conversación | — | Pasado ese tamaño, el chat queda de solo lectura y la persona empieza uno nuevo. |
| Instrucciones para el asistente | — | Tu propia guía, sumada a la de lazyit en cada conversación (convenciones de la casa, idioma preferido). No puede ampliar lo que el asistente puede hacer, y se envía al proveedor. |

## Búsqueda web

**Permitir que el asistente busque en la web** deja que el chat busque en internet cuando los registros
y la base de conocimiento de lazyit no tienen la respuesta — por ejemplo, la documentación de un
producto de terceros para el que alguien le pide armar un workflow. Viene **desactivada**.

- **Qué sale.** La búsqueda la hace el proveedor; las consultas y el contexto de la conversación van a
  él, y quizá a un socio de búsqueda. Las búsquedas se pueden cobrar aparte. Revisá antes tu contrato con
  el proveedor. Mirá [Qué sale de tu servidor](/help/ai-assistant-overview#hacia-socios-de-búsqueda-búsqueda-web-desactivada-por-defecto).
- **Qué proveedores.** Anthropic, OpenAI y Google Gemini 3 o posterior. El proveedor compatible con OpenAI
  y los modelos Gemini anteriores no tienen una búsqueda que funcione junto con las herramientas de
  lazyit; en ese caso el interruptor queda deshabilitado y la tarjeta explica por qué.
- **Solo el chat.** Las ejecuciones headless nunca buscan, porque sus cambios se aplican sin que nadie
  los apruebe. Los clientes MCP buscan con sus propias herramientas, si las tienen.
- **Los resultados no son confiables.** Una vez que el asistente buscó en la web en una conversación,
  **ya no se aprueba automáticamente nada en esa conversación** — cada cambio muestra su tarjeta, aunque
  la aprobación automática esté activa.
- **OpenAI** busca en su copia en caché e indexada de la web, no en páginas en vivo, así que puede faltar
  lo muy reciente. Su búsqueda también puede "abrir" una página; eso no se puede desactivar, pero la
  página sale de la caché, no de su sitio.
- **Búsquedas por paso** (5 por defecto, entre 1 y 20) limita las búsquedas en un paso del modelo, donde
  el proveedor soporta un límite (Anthropic).
- **Rige para conversaciones nuevas.** Al desactivarla, los chats que la tenían quedan de solo lectura.

Tu cuenta en el proveedor también puede tener la búsqueda web deshabilitada de su lado (Anthropic: la
configuración de privacidad de la organización en la Claude Console; OpenAI: los permisos de
herramientas de la organización o del proyecto). Si está deshabilitada ahí mientras este interruptor
está activo, fallan los chats que tienen búsqueda web — mirá
[Resolución de problemas](/help/ai-assistant-troubleshooting#la-búsqueda-web-está-deshabilitada-en-el-proveedor).

## Extracción de documentos

**Permitir leer documentos de compras con IA** deja que las personas completen una compra desde una
factura, un presupuesto o un remito adjunto: el proveedor lee el documento y lazyit muestra un borrador que
una persona revisa — mirá [Leer un documento con IA](/help/purchases-recording-purchases#leer-un-documento-con-ia).
Viene **desactivada**, también en las instancias que se actualizaron.

- **Qué sale.** El **archivo completo** del documento que alguien elige leer — con el proveedor, los
  precios y los IDs fiscales que muestre — va al proveedor configurado, bajo tu contrato con él. No se
  guarda nada de él hasta que una persona revisa el borrador y guarda la compra. Mirá
  [Qué sale de tu servidor](/help/ai-assistant-overview#documentos-de-compras-extracción-de-documentos-desactivada-por-defecto).
- **Necesita el asistente activado**, y un proveedor que lea documentos: Anthropic, OpenAI o Google Gemini.
  El proveedor compatible con OpenAI nunca se usa para esto (sus servidores no tienen una forma común de
  leer un archivo); el interruptor queda deshabilitado y la tarjeta dice por qué. Sigue usable mientras está
  activado, así que siempre lo podés desactivar.
- **Quién lo ve.** Las personas que pueden editar compras y usar el asistente de IA. Las cuentas de
  servicio nunca leen documentos.
- **Qué lee.** Documentos PDF e imágenes, de hasta 10 MB (algo menos para imágenes con Anthropic; Gemini
  no lee GIF) y 20 páginas. Los Word, planillas y archivos de
  texto nunca se envían.
- **Presupuesto y registro.** Cada lectura cuenta para el presupuesto diario de tokens de la persona (el
  mismo que el del chat), y el registro de actividad de la compra la registra — nunca los valores leídos.

## Agentes de IA externos (MCP)

**Permitir agentes de IA externos** deja que clientes MCP como Claude Code se conecten a lazyit como la
persona que los conecta (que además necesita **Conectar agentes de IA externos (MCP)**). Es
independiente del asistente: funciona sin proveedor configurado y no necesita `AI_SECRET_KEY`.
Desactivarlo desconecta todos los clientes a la vez; sus autorizaciones vuelven a funcionar al
reactivarlo.

La tarjeta muestra:

- **El endpoint MCP** — la dirección para un cliente que se configura a mano: el `WEB_ORIGIN` de la API
  seguido de `/mcp`. Si no hay `WEB_ORIGIN` fijado, la tarjeta muestra la dirección de esta página y lo
  aclara; los clientes en otras máquinas quizá necesiten la dirección de la instancia en tu red.
- **Cómo inician sesión los clientes en esta instancia**, según el `WEB_ORIGIN` — no según si esta
  página se ve por HTTPS:

  | `WEB_ORIGIN` | Los clientes inician sesión con |
  | --- | --- |
  | una dirección `https://` | **OAuth** — el cliente abre una página de consentimiento de lazyit en el navegador; no hay nada que copiar. |
  | cualquier otra cosa (por ejemplo el modo `lan` por HTTP plano) | **Tokens personales** que cada persona crea en **Cuenta → IA y apps conectadas**. |

  Poner un proxy TLS delante de lazyit **no** alcanza por sí solo: configurá `WEB_ORIGIN` con la
  dirección `https://` que usa la gente y reiniciá la API para pasar a OAuth. Si tu certificado viene de
  una **autoridad certificante interna**, los clientes Node.js como Claude Code tienen que arrancar con
  ella (`NODE_EXTRA_CA_CERTS`).
- **Los pasos de Instalar en Claude Code** — los mismos que en **Cuenta → IA y apps conectadas**.

**Los conectores en la nube** — claude.ai, los conectores de Claude Desktop y ChatGPT — se conectan
desde los servidores del proveedor, así que solo funcionan si la instancia es accesible desde internet
por HTTPS con un certificado de confianza pública. Los clientes de escritorio y de línea de comandos solo
necesitan llegar a lazyit desde la computadora de la persona. Los pasos del lado de cada persona están en
[Claude Code y MCP](/help/ai-assistant-claude-code-mcp).

### Clientes permitidos

Dos cosas de la tarjeta MCP deciden qué clientes pueden conectarse:

- **Aceptar cualquier cliente con callback https:// — activado por defecto.** Cualquier cliente MCP cuyo
  callback de inicio de sesión sea una dirección `https://` puede *pedirle* acceso a una persona, aunque
  no esté en la lista. Eso solo no otorga nada: la persona igual ve la página de consentimiento, que
  muestra el host del callback y advierte si el cliente no está verificado. Nunca admite un callback de
  loopback (`http://127.0.0.1/…`) ni uno con esquema de app como `cursor://…` — esos necesitan una
  entrada en la lista. **Desactivalo para aceptar solo los clientes de la lista.**
- **La lista.** lazyit trae **clientes incluidos** — Claude Code, OpenAI Codex, OpenCode, Gemini CLI,
  Cursor, VS Code / GitHub Copilot, claude.ai, Claude Desktop y ChatGPT — cada uno con su identificador
  y cómo se comprobó (**Verificado** desde el propio código o documentación del cliente, o **Docs del
  proveedor**). **Quitá** un cliente incluido para que deje de conectarse, y **Restauralo** cuando
  quieras. Pi, Windsurf y Zed no vienen incluidos porque sus identificadores no se pudieron verificar —
  agregalos vos. Un cliente incluido que quitaste y que una versión posterior de lazyit ya no trae
  aparece en **Clientes quitados que ya no están en la lista incluida**; restaurarlo solo borra tu
  exclusión.

**Agregar un cliente** por una de estas vías:

- su **URL de metadatos del cliente** — la URL `https://` que el cliente usa como id de cliente; o
- su **dirección de callback** — la dirección exacta a la que devuelve a las personas después de
  iniciar sesión: `https://…`, una dirección de loopback como `http://127.0.0.1/callback` (coincide
  cualquier puerto) o un esquema de app como `com.example.app:/callback` o `cursor://…`.

Un cliente se reconoce solo así — nunca por el nombre que se da a sí mismo. `http://` plano se acepta
solo en loopback, una dirección con usuario (`…@…`) se rechaza siempre, y los esquemas de app solo se
aceptan como entradas explícitas. Podés agregar hasta 100 clientes.

En la página de consentimiento, un cliente aparece como **Verificada** solo cuando se identifica con una
URL de metadatos **y** esa URL está en esta lista — mirá
[La pantalla de consentimiento](/help/ai-assistant-claude-code-mcp#la-pantalla-de-consentimiento).

## Cuentas de servicio

Las cuentas de servicio usan la IA sin personas — por la API (`POST /api/ai/runs`) o por MCP — y nadie
aprueba sus cambios uno por uno. En **Configuración → Cuentas de servicio**, abrí el menú de la fila de
una cuenta y elegí **Acceso a IA**:

- **Desactivado** — ningún uso de IA: se rechazan las ejecuciones headless y MCP.
- **Solo lectura** — el asistente solo puede leer.
- **Lectura y escritura** — también puede hacer cambios dentro de los permisos de la cuenta. Es el valor
  por defecto de una cuenta que nunca se configuró.
- **Limitar escrituras** (solo con lectura y escritura) — pone un tope a los cambios por ejecución
  headless y, como MCP no tiene ejecuciones, por hora móvil en MCP. **Cuenta cada registro**: un lote
  que actualiza 20 activos son 20 cambios (las filas omitidas no cuentan), y un lote más grande que lo
  que queda bajo el tope se rechaza entero, sin cambiar nada.

El acceso a IA solo acota lo que ya permiten los permisos de la cuenta; nunca otorga uno. La cuenta
además necesita **Usar el asistente de IA** para ejecuciones headless y **Conectar agentes de IA
externos (MCP)** para MCP. A una cuenta que tiene **Reportar inventario de servidores (agente)** — la
credencial de reporte de los agentes — se le niega el uso de IA elijas lo que elijas; creá una cuenta
aparte para la IA. Mirá también [Cuentas de servicio](/help/users-permissions-service-accounts).

## Desactivarlo

**Desactivar el asistente** (abajo de todo en la página) lo oculta para todos y rechaza pedidos nuevos
al instante. Las conversaciones se conservan y se siguen borrando al vencer su retención; los cambios
que esperan aprobación no se pueden aprobar mientras esté desactivado. El proveedor, el modelo y la
clave cifrada se conservan, así que reactivarlo es un solo paso. Los agentes de IA externos no se ven
afectados — tienen su propio interruptor.

## Después de actualizar lazyit

Una actualización que cambia las herramientas o las instrucciones del asistente deja **de solo lectura**
los chats iniciados antes; para seguir, se empieza un chat nuevo. No hace falta nada más — la
configuración, las claves, las apps conectadas y los tokens personales se mantienen.

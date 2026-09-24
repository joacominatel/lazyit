---
title: Asistente de IA — configuración
order: 1
category: ai-assistant
subcategory: setup
---

# Asistente de IA — configuración

Todo lo relacionado con IA se configura en **Configuración → IA**, que requiere el permiso **Configurar
la instancia**. La página tiene cuatro partes: el proveedor del asistente (un asistente de configuración
mientras está desactivado, un editor una vez activo), **Comportamiento y límites**, **Agentes de IA
externos (MCP)** y — una vez activo — **Desactivar el asistente de IA**.

## Antes de empezar: `AI_SECRET_KEY`

Las claves de API de los proveedores se guardan cifradas con una clave propia, la variable de entorno
`AI_SECRET_KEY` del servicio de la API. Genera una con `openssl rand -hex 32`, defínela y reinicia la API.
Hasta que esté definida, Configuración → IA lo avisa arriba, no se puede guardar ninguna clave de API y solo
se puede usar un servidor compatible con OpenAI sin clave. MCP no la necesita.

## El asistente de configuración

Mientras el asistente está desactivado, Configuración → IA te guía en cinco pasos. Cada paso guarda lo que
ingresaste (todavía desactivado), así que puedes dejarlo y volver — se reabre donde lo dejaste.

1. **Proveedor** — Anthropic, OpenAI, Google Gemini o **compatible con OpenAI**: cualquier servidor que
   hable la API de OpenAI, como un modelo que alojas en tu red o un gateway.
2. **Credenciales** — la clave de API del proveedor. Se guarda cifrada y **no se vuelve a mostrar**, ni
   siquiera a los administradores; para cambiarla escribes una nueva. Para un servidor compatible con
   OpenAI también indicas su **URL base** (normalmente terminada en `/v1`); consulta
   [Servidores en red privada](#servidores-en-red-privada).
3. **Modelo** — elige una sugerencia o escribe cualquier id de modelo que acepte tu proveedor y, si
   quieres, el **esfuerzo de razonamiento** (y una temperatura para un servidor compatible con OpenAI).
4. **Prueba** — lazyit comprueba que el proveedor acepta la clave, conoce el modelo y que el modelo puede
   **llamar herramientas**. El asistente no funciona sin llamadas a herramientas, así que no puedes
   continuar hasta que la prueba pase. Si falla, la página explica por qué (una clave rechazada, un modelo
   desconocido, un host inalcanzable…).
5. **Activar** — revisa qué sale de tu servidor (consulta
   [Asistente de IA — visión general](/help/ai-assistant-overview#qué-sale-de-tu-servidor)), confirma que
   puedes enviarlo al proveedor y pulsa **Activar el asistente de IA**. La página se recarga y las personas
   con el permiso **Usar el asistente de IA** ven el asistente en la barra superior — el resto en menos de
   un minuto o al recargar.

lazyit vuelve a comprobar todo al activarlo: si en ese momento la prueba de conexión falla, no cambia nada
y la página muestra el resultado de la prueba.

## Cambiar el proveedor, el modelo o la clave

Con el asistente activo, **Proveedor y modelo** reemplaza al asistente de configuración. Puedes cambiar de
proveedor, cambiar el modelo o las opciones, o escribir una clave nueva para reemplazar la guardada;
**Probar esta configuración** prueba tus cambios antes de guardarlos. Cualquier cambio en la conexión se
vuelve a probar al guardar — si la prueba falla, no se guarda nada y el asistente sigue funcionando con la
configuración anterior.

Cambiar el **proveedor** o la **URL base** descarta la clave guardada (una clave pertenece a un único
destino), así que escribe la clave del nuevo destino en el mismo guardado.

## Servidores en red privada

Para un modelo propio, elige **compatible con OpenAI** e indica su dirección en tu red. Activa **Servidor en
una red privada** para permitir una dirección privada (10.x, 172.16–31.x, 192.168.x, o un nombre interno que
resuelva a una); solo así se acepta una dirección `http://` sin cifrar. Algunas direcciones se rechazan
siempre: `localhost` y otras de loopback (apuntarían al propio contenedor de la API), las link-local y las
de metadatos de la nube. La URL base no puede contener usuario, contraseña, query string ni fragmento — la
clave va en el campo de clave de API.

## Comportamiento y límites

Se aplican a todas las conversaciones y se pueden cambiar en cualquier momento, con el asistente activo o
no:

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| Guardar las conversaciones durante | 90 días | Las conversaciones más antiguas se borran automáticamente (7–3650 días). El registro de acciones ejecutadas se conserva. |
| Las tarjetas de aprobación vencen a los | 30 minutos | Un cambio propuesto que nadie aprueba a tiempo ya no se puede aprobar. |
| Presupuesto diario de tokens por persona | 2.000.000 | El máximo de tokens que una persona o cuenta de servicio puede usar en cualquier período de 24 horas. Desactívalo para no tener presupuesto. |
| Largo máximo de respuesta, pasos máximos, tamaño de conversación | — | Límites para una respuesta, para cuántas herramientas puede encadenar un pedido y para cuánto puede crecer una conversación. |
| Instrucciones para el asistente | — | Tus propias indicaciones, agregadas a las de lazyit en cada conversación (convenciones de la casa, idioma preferido). No pueden ampliar lo que el asistente puede hacer. |

## Búsqueda web

**Permitir que el asistente busque en la web** deja que el chat busque en internet cuando los registros y la
base de conocimiento de lazyit no tienen lo que necesita — por ejemplo, la documentación de un producto de
terceros para el que alguien le pide configurar un workflow. Viene **desactivada**.

- **Dónde se hace la búsqueda.** La hace el proveedor de IA en sus propios servidores; lazyit no hace ninguna
  solicitud propia. Las consultas y el contexto de la conversación van al proveedor, que puede pasar las
  consultas a su motor de búsqueda o a un socio de búsqueda, y puede facturar las búsquedas aparte. Revisá
  tu contrato con el proveedor antes de activarla.
- **Qué proveedores.** Anthropic, OpenAI y Google Gemini 3 o posterior. El proveedor compatible con OpenAI y
  los modelos Gemini anteriores no tienen una búsqueda web que el asistente pueda usar junto con las
  herramientas de lazyit; en ese caso el interruptor aparece deshabilitado y la tarjeta explica por qué.
- **Solo el chat.** Las ejecuciones headless (cuentas de servicio) nunca buscan en la web, porque sus
  cambios se aplican sin que nadie los apruebe.
- **Los resultados se tratan como no confiables.** Las páginas web las escribe cualquiera. El asistente las
  toma como información, nunca como instrucciones, y muestra debajo de su respuesta las páginas que usó.
  **Una vez que buscó en la web en una conversación, nada en esa conversación se aprueba automáticamente**:
  cada cambio que proponga ahí muestra su tarjeta de aprobación, aunque la persona haya activado la
  aprobación automática — los resultados quedan en la conversación.
- **OpenAI.** lazyit usa la búsqueda de OpenAI sobre su copia en caché e indexada de la web, no sobre
  páginas en vivo, así que pueden faltar páginas muy recientes. La búsqueda de OpenAI también puede abrir
  páginas; eso no se puede desactivar, pero nunca descarga una página en vivo desde su sitio.
- **Conversaciones nuevas.** El interruptor se aplica a los chats que empiecen después del cambio. Al
  desactivarla, los chats que la tenían pasan a ser de solo lectura; para seguir, se empieza un chat nuevo.
- **Búsquedas por paso** (5 por defecto, de 1 a 20) es la cantidad máxima de búsquedas que el asistente puede
  hacer en un paso, donde el proveedor admite un límite (Anthropic).

## Agentes de IA externos (MCP)

**Permitir agentes de IA externos** deja que clientes MCP como Claude Code se conecten a lazyit, actuando
como la persona que los conecta y con sus permisos (también necesitan el permiso **Conectar agentes de IA
externos (MCP)**). Este interruptor es independiente del asistente: funciona sin ningún proveedor
configurado. Desactivarlo desconecta todos los clientes a la vez; sus autorizaciones vuelven a valer al
reactivarlo.

La tarjeta muestra el **endpoint MCP** — la dirección pública de `WEB_ORIGIN` en la API seguida de `/mcp`
(si no hay una dirección fijada, muestra la de la página en la que estás y lo indica) — y explica cómo
inician sesión los clientes en **esta** instancia. Eso depende de la opción `WEB_ORIGIN` de la API — la
dirección pública a la que está fijado lazyit —, no solo de si la página se muestra por HTTPS:

- **`WEB_ORIGIN` es una dirección `https://`: OAuth.** El cliente abre una página de lazyit en el navegador donde la persona revisa el
  acceso y lo aprueba. Si tu certificado lo emite una **autoridad de certificación interna**, Claude Code y
  otros clientes Node.js deben iniciarse con ella, por ejemplo
  `export NODE_EXTRA_CA_CERTS=/ruta/a/ca-interna.pem`.
- **Sin un `WEB_ORIGIN` `https://` (por ejemplo, el modo `lan` por HTTP sin cifrar): tokens personales.**
  El inicio de sesión con OAuth requiere HTTPS y una dirección pública fija — si no, los códigos y tokens
  podrían viajar sin cifrar o a otro host —, así que no está disponible. Cada persona crea en su lugar un
  token MCP personal y se lo da a su cliente. Poner un proxy TLS delante de lazyit **no** alcanza por sí
  solo: define `WEB_ORIGIN` con la dirección `https://` que usan las personas y reinicia la API para pasar
  a OAuth.
- **Los conectores en la nube** — claude.ai, los conectores de Claude Desktop y ChatGPT — se conectan desde
  los servidores del proveedor, no desde la computadora de la persona, así que solo funcionan si tu
  instancia es alcanzable desde internet por HTTPS con un certificado de confianza pública.

Con MCP activado, la tarjeta también muestra los pasos de **Instalar en Claude Code** (los mismos que en
**Cuenta → IA y aplicaciones conectadas**). Las aplicaciones conectadas y los tokens personales de cada
persona están en esa página de la cuenta.

### Clientes permitidos

Qué clientes pueden conectarse lo deciden dos cosas, ambas en la tarjeta de MCP:

- **Aceptar cualquier cliente con callback https:// — activado por defecto.** Cualquier cliente MCP cuyo
  callback de inicio de sesión sea una dirección `https://` puede *pedirle* acceso a una persona, aunque no
  esté en la lista. Esto por sí solo no otorga nada: la persona igual ve la página de consentimiento, que
  muestra el host del callback del cliente y avisa cuando un cliente no estaba en la lista. Nunca admite un
  callback de loopback (`http://127.0.0.1/…`) ni de esquema de aplicación como `cursor://…` — esos
  necesitan una entrada. **Desactívalo para aceptar solo los clientes de la lista.**
- **La lista.** lazyit trae una lista de **clientes incluidos** — Claude Code, OpenAI Codex, OpenCode,
  Gemini CLI, Cursor, VS Code / GitHub Copilot, claude.ai, Claude Desktop y ChatGPT —, cada uno con su
  identificador y cómo se comprobó (**Verificado** desde el código o la documentación del propio cliente, o
  **Docs del proveedor**). **Quita** un cliente incluido para que deje de conectarse (mientras “cualquier
  cliente https://” esté activado, un cliente quitado con callback `https://` todavía puede pedir
  consentimiento), y **Restáuralo** cuando quieras. Pi, Windsurf y Zed no vienen incluidos porque sus
  identificadores no se pudieron verificar — agrégalos tú si tu equipo los usa.

Para permitir otro cliente, usa **Agregar un cliente** con uno de estos datos:

- su **URL de metadatos de cliente** — la URL `https://` que el cliente usa como id de cliente; o
- su **dirección de callback** — la dirección exacta a la que devuelve a la persona después de iniciar
  sesión: `https://…`, una dirección de loopback como `http://127.0.0.1/callback` (vale cualquier puerto),
  o un esquema de aplicación como `com.example.app:/callback` o `cursor://…`.

Un cliente solo se reconoce de esta forma — nunca por el nombre que se da a sí mismo. `http://` sin cifrar
solo se acepta en una dirección de loopback, una dirección con usuario (`…@…`) se rechaza siempre, y los
esquemas de aplicación solo se aceptan como entrada explícita.

## Cuentas de servicio

Las cuentas de servicio usan el asistente sin interfaz — por la API o por MCP — y sus cambios no se aprueban
uno por uno. En **Configuración → Cuentas de servicio**, abre el menú de la fila de una cuenta y elige
**Acceso a IA**:

- **Desactivado** — ningún uso de IA para esta cuenta.
- **Solo lectura** — el asistente solo puede leer.
- **Lectura y escritura** — el asistente también puede hacer cambios dentro de los permisos de la cuenta.
  Es el valor por defecto de una cuenta nunca configurada.
- **Limitar escrituras** (solo con lectura y escritura) — limita los cambios por ejecución sin interfaz y,
  como MCP no tiene ejecuciones, por hora móvil en MCP.

El acceso a IA solo restringe lo que permiten los permisos de la cuenta; nunca otorga uno. La cuenta además
necesita **Usar el asistente de IA** para las ejecuciones sin interfaz y **Conectar agentes de IA externos
(MCP)** para MCP. Una cuenta con **Reportar inventario de servidores (agente)** — la credencial de reporte de
los agentes — tiene rechazado el uso de IA elijas lo que elijas; crea una cuenta aparte para IA.

## Desactivarlo

**Desactivar el asistente** (al final de la página) lo oculta para todos y rechaza los pedidos nuevos. Las
conversaciones se conservan y se siguen borrando al vencer su retención; los cambios que esperan aprobación
no se pueden aprobar mientras esté desactivado. El proveedor, el modelo y la clave cifrada se conservan, así
que reactivarlo es un solo paso. Los agentes de IA externos no se ven afectados — tienen su propio
interruptor.

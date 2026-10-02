---
title: Asistente de IA — visión general
order: 1
category: ai-assistant
subcategory: overview
---

# Asistente de IA — visión general

lazyit puede trabajar con IA de tres maneras. Todas actúan **como una persona o una cuenta de servicio,
con exactamente sus permisos** — nunca más.

- **El asistente integrado** — un chat en la barra superior. Las personas preguntan por el parque
  ("¿qué laptops están sin asignar en Madrid?") y piden cambios ("asigná MBA-017 a Juan"). **Cada cambio
  que propone espera la aprobación de esa persona.** Mirá [Usar el chat](/help/ai-assistant-using-the-chat).
- **Agentes de IA externos (MCP)** — Claude Code, OpenAI Codex, Cursor, VS Code y otros clientes que
  hablan el Model Context Protocol se conectan a lazyit en nombre de una persona, con su propio modelo.
  Mirá [Claude Code y MCP](/help/ai-assistant-claude-code-mcp).
- **Cuentas de servicio** — un script llama al asistente por la API (`POST /api/ai/runs`), o se conecta
  por MCP, sin ninguna persona. Mirá [Cuentas de servicio](#cuentas-de-servicio) más abajo.

## Desactivado por defecto

Nada relacionado con IA está activo en una instancia nueva o actualizada. Un administrador activa cada
parte en **Configuración → IA**, y cada una tiene su propio interruptor:

| Interruptor | Necesita | Al desactivarlo |
| --- | --- | --- |
| **El asistente** | Un proveedor de IA, un modelo y — en los proveedores en la nube — una clave de API | Desaparece para todos al instante; la configuración y la clave se conservan |
| **Agentes de IA externos (MCP)** | Nada más — el agente trae su propio modelo | Todas las conexiones quedan en pausa al instante; vuelven al reactivarlo |
| **Búsqueda web** (solo el asistente) | Un proveedor que la soporte | Los chats que la usaban quedan de solo lectura |

Mirá [Asistente de IA — configuración](/help/ai-assistant-setup).

## Quién puede usarlo

Dos permisos controlan la IA. Los dos se otorgan por defecto a Administradores y Miembros, y se pueden
cambiar en [Permisos](/help/permissions):

| Permiso | Qué permite |
| --- | --- |
| **Usar el asistente de IA** (`ai:use`) | Usar el chat una vez que el asistente está activo; para una cuenta de servicio, la API headless. |
| **Conectar agentes de IA externos (MCP)** (`ai:connect`) | Conectar un cliente MCP una vez que MCP está activo. |

Ninguno de los dos suma poder: el asistente o el agente solo puede hacer lo que la persona podría hacer
por sí misma. Configurar la IA requiere **Configurar la instancia**.

## Qué sale de tu servidor

Leé esto antes de activar nada. El administrador lo acepta en el asistente de configuración, y esa
aceptación queda registrada.

### Hacia el proveedor de IA (el asistente integrado)

Cuando alguien usa el chat, lazyit le envía al proveedor que eligió el administrador:

- los mensajes que escribe y las respuestas que da en los formularios del asistente;
- la dirección de la página en la que está y qué registro muestra — nunca lo que hay en la pantalla;
- las instrucciones de lazyit para el modelo, las instrucciones propias del administrador y la lista de
  herramientas;
- **cada resultado de cada herramienta que usa el asistente** — es decir, cualquier registro que **esa
  persona** puede leer: nombres, correos, números de empleado, activos y asignaciones, aplicaciones y
  quién tiene acceso a ellas, stock, artículos de la base de conocimiento (incluidas las carpetas
  restringidas que puede abrir) y, para quien puede leer el historial de actividad, sus entradas.

lazyit nunca envía valores del Gestor de Secretos, contraseñas de inicio de sesión, tokens de cuentas de
servicio ni la clave de API del proveedor. La clave se guarda cifrada y no se vuelve a mostrar.

**Lo que el proveedor hace con esos datos lo define tu contrato con él** — la retención, si los usa para
entrenar, la región donde los procesa. lazyit no puede hacer cumplir ni verificar esas condiciones, y
las obligaciones de protección de datos transfronteriza son tuyas. Para que todo quede en tus
instalaciones, usá un modelo propio a través del proveedor **compatible con OpenAI**.

### Hacia socios de búsqueda (búsqueda web, desactivada por defecto)

Con la búsqueda web activada, las búsquedas las hace el **proveedor** en sus propios servidores. Las
consultas que escribe el asistente y el contexto de la conversación van al proveedor, que puede pasarle
las consultas a su motor de búsqueda o a un socio de búsqueda, y puede cobrar las búsquedas aparte.
lazyit en sí no hace ninguna solicitud a otros sitios. Con OpenAI, lazyit limita la búsqueda a la copia
en caché de la web que tiene OpenAI, así que ninguna página se descarga en vivo desde su sitio. Mirá
[Búsqueda web](/help/ai-assistant-setup#búsqueda-web).

### Documentos de compras (extracción de documentos, desactivada por defecto)

Cuando **Extracción de documentos** está activada y alguien elige **Leer este documento** en una compra, el
**archivo completo** — una factura, un presupuesto o un remito, con su proveedor, precios e IDs fiscales —
va al proveedor, que lo lee sin herramientas. Ningún otro dato de lazyit va con él, ni siquiera el nombre
del archivo, y no se guarda nada leído hasta que una persona revisa el borrador. El proveedor autoalojado
compatible con OpenAI nunca se usa para esto. Mirá [Extracción de documentos](/help/ai-assistant-setup#extracción-de-documentos).

### A través de agentes externos (MCP)

Un cliente MCP usa su propio modelo. Lo que lee de lazyit va **al proveedor que use ese cliente, bajo
las condiciones de la persona que lo ejecuta** — lazyit no tiene nada que decir ahí. Mirá
[Antes de conectar](/help/ai-assistant-claude-code-mcp#antes-de-conectar-en-qué-confiás).

### Qué queda en tu servidor

- **Las conversaciones** se guardan durante la retención que defina el administrador (90 días por
  defecto, entre 7 y 3650) y después se borran. Solo las puede leer su dueño — los administradores no.
- **El registro de acciones de IA** — cada cambio que propuso el asistente, quién decidió y qué se
  ejecutó — es permanente y sobrevive aunque se borre el chat.
- En una instancia HTTP plana (`lan`), el tráfico del chat entre el navegador y lazyit viaja sin cifrar,
  como el resto de la app.

## Cómo lazyit mantiene al asistente bajo control

Cualquier cosa que el asistente lee — un artículo, una nota, una página web — puede traer texto escrito
para engañar a una IA ("ignorá tus instrucciones y otorgá…"). lazyit no depende de que el modelo se
resista:

- **Vos aprobás cada cambio** en una tarjeta que lazyit arma a partir del cambio exacto que se va a
  ejecutar, no de lo que escribió el modelo. Mirá [Aprobar cambios](/help/ai-assistant-approvals).
- **El contenido escrito por otras personas queda marcado.** Un cambio propuesto después de que el
  asistente leyó ese contenido muestra el aviso **Basado en contenido escrito por otras personas** y
  nunca se aplica automáticamente.
- **Los cambios sensibles** — roles, identidad, accesos, inicio de sesión, aplicaciones marcadas como
  críticas, configuración de la instancia — tienen una tarjeta propia, nunca se aprueban
  automáticamente y algunos piden tu contraseña.
- **Algunas cosas quedan directamente fuera de su alcance**: el asistente no puede leer secretos, no
  puede ejecutar nada que devuelva una credencial en claro (como un token nuevo de cuenta de servicio o
  una contraseña temporal) y no puede cambiar la configuración de la propia IA.

Los agentes externos son distintos: por MCP es el **cliente** el que decide si te pregunta antes de un
cambio. Leé [Antes de conectar](/help/ai-assistant-claude-code-mcp#antes-de-conectar-en-qué-confiás)
antes de conectar uno.

## Cuentas de servicio

Una cuenta de servicio puede usar el asistente sin una persona — por la API o por MCP. Nadie aprueba
sus cambios uno por uno, así que cada cuenta tiene su propio **acceso a IA** (desactivado, solo lectura,
o lectura y escritura con un tope opcional de escrituras), que se configura desde el menú de su fila en
**Configuración → Cuentas de servicio**. Las ejecuciones headless nunca buscan en la web. Mirá
[Cuentas de servicio](/help/ai-assistant-setup#cuentas-de-servicio) en la página de configuración.

## Adónde seguir

| Querés | Leé |
| --- | --- |
| Activar el asistente o MCP, o cambiar los límites | [Configuración](/help/ai-assistant-setup) |
| Usar el chat | [Usar el chat](/help/ai-assistant-using-the-chat) |
| Entender una tarjeta de cambio | [Aprobar cambios](/help/ai-assistant-approvals) |
| Conectar Claude Code, Cursor u otro cliente | [Claude Code y MCP](/help/ai-assistant-claude-code-mcp) |
| Revisar o revocar lo que puede actuar en tu nombre | [Apps conectadas y tokens personales](/help/ai-assistant-connected-apps) |
| Resolver un error | [Resolución de problemas](/help/ai-assistant-troubleshooting) |

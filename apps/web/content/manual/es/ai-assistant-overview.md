---
title: Asistente de IA — visión general
order: 1
category: ai-assistant
subcategory: overview
---

# Asistente de IA — visión general

lazyit puede incluir un **asistente de IA**: un chat en la barra superior donde las personas hacen
preguntas sobre el parque ("¿qué laptops están sin asignar en Madrid?") y piden cambios ("asigna MBA-017
a Juan"). El asistente trabaja a través del propio lazyit — lee y modifica registros con las mismas reglas
y los mismos permisos que la persona que lo usa — y **cada cambio que propone espera a que esa persona lo
apruebe** antes de que ocurra nada.

lazyit también puede permitir que **agentes de IA externos** — Claude Code, OpenAI Codex, Cursor,
OpenCode y otros clientes que hablan el Model Context Protocol (MCP) — trabajen con lazyit en nombre de
una persona.

## Desactivado por defecto

Nada relacionado con IA está activo en una instancia nueva o actualizada. Un administrador activa cada
parte en **Configuración → IA**:

- **El asistente** necesita un proveedor de IA (Anthropic, OpenAI, Google Gemini o cualquier servidor
  compatible con OpenAI, incluido uno propio), un modelo y — para los proveedores en la nube — una clave de
  API. Consulta [Asistente de IA — configuración](/help/ai-assistant-setup).
- **Los agentes de IA externos (MCP)** tienen su propio interruptor. Funcionan incluso sin ningún
  proveedor configurado, porque el agente trae su propio modelo.

Desactivar cualquiera de los dos es inmediato y conserva la configuración para más adelante.

Con MCP activado, los clientes conocidos están permitidos de entrada y — por defecto — cualquier otro
cliente con un callback de inicio de sesión `https://` puede pedirle acceso a una persona; la persona siempre
ve quién lo pide antes de aprobar. Un administrador puede restringirlo a una lista fija. Consulta
[Asistente de IA — configuración](/help/ai-assistant-setup#clientes-permitidos).

## Qué sale de tu servidor

Cuando alguien usa el asistente integrado, lazyit envía al proveedor que elegiste:

- los mensajes que escribe;
- la página en la que está — su dirección y el registro que muestra, nunca el resto de la página;
- los registros que el asistente lee para responder: activos, personas, aplicaciones y accesos, stock,
  artículos de la base de conocimiento — solo lo que **esa persona** puede ver.

Nunca envía secretos de las bóvedas ni contraseñas, y la clave de API del proveedor se guarda cifrada y
no se vuelve a mostrar. El administrador acepta esto antes de poder activar el asistente. Las
conversaciones también se guardan en tu servidor durante el período de retención que elija el
administrador (90 días por defecto, entre 7 y 3650), y después se borran; el registro de lo que el
asistente realmente cambió se conserva igual.

Si el administrador activa la **búsqueda web** (desactivada por defecto), el proveedor también puede buscar
en internet para el chat: hace la búsqueda en sus propios servidores con consultas que escribe el
asistente, así que la consulta y el contexto de la conversación van a la búsqueda del proveedor. lazyit en
sí no hace ninguna solicitud a otros sitios. Mirá [Asistente de IA — configuración](/help/ai-assistant-setup#búsqueda-web).

Los agentes externos por MCP usan su propio modelo: lo que leen de lazyit va al proveedor que use ese
agente, bajo el control de la persona que lo ejecuta.

## Quién puede usarlo

Dos permisos controlan la IA; ambos se otorgan por defecto a Administradores y Miembros y se configuran en
[Permisos](/help/permissions):

| Permiso | Qué permite |
| --- | --- |
| **Usar el asistente de IA** (`ai:use`) | Ver el chat y usarlo, una vez que un administrador activó el asistente. |
| **Conectar agentes de IA externos (MCP)** (`ai:connect`) | Conectar un cliente MCP como Claude Code, una vez que un administrador activó MCP. |

En cualquier caso, el asistente o el agente solo puede hacer lo que la persona podría hacer por sí misma.
Configurar la IA requiere **Configurar la instancia**.

## Cuentas de servicio

Las cuentas de servicio pueden usar el asistente sin una persona: por la API o por MCP. Como nadie aprueba
sus cambios uno por uno, cada cuenta tiene su propio **acceso a IA** — desactivado, solo lectura, o lectura
y escritura con un límite opcional de escrituras — que se configura desde el menú de su fila en
**Configuración → Cuentas de servicio**. Consulta
[Asistente de IA — configuración](/help/ai-assistant-setup#cuentas-de-servicio) y
[Cuentas de servicio](/help/users-permissions-service-accounts).

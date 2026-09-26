---
title: Apps conectadas y tokens personales
order: 1
category: ai-assistant
subcategory: connected-apps
---

# Apps conectadas y tokens personales

Cada app de IA que puede actuar en tu nombre aparece en **Apps conectadas**, en **IA y apps conectadas**
(menú de usuario → **IA y apps conectadas**, en `/account/ai`). Revisala cada tanto y cortá todo lo que
no reconozcas.

## Qué muestra la lista

Cada fila es una conexión:

- **Apps** que aprobaste en la [pantalla de consentimiento](/help/ai-assistant-claude-code-mcp#la-pantalla-de-consentimiento)
  — su nombre (marcado **Sin verificar** salvo que lazyit haya confirmado al publicador), el **dominio**
  donde lazyit comprobó sus datos cuando la app publica uno (por ejemplo **Dominio: claude.ai**), y la
  dirección por la que inicia sesión. El nombre es lo que la app dice de sí misma; el dominio es lo que
  comprobó lazyit.
- **Tokens personales** que creaste, con el nombre que les pusiste.

Cada una muestra qué puede hacer (**Lectura**, **Escritura**, **Admin**), cuándo se conectó, cuándo se
**usó por última vez** y — para un token — cuándo **vence**.

## Revocar

Hacé clic en **Revocar** y confirmá. La app o el token pierde el acceso en su **próximo pedido**. Una app
tiene que aprobarse de nuevo para reconectarse; un token revocado no se puede recuperar.

Revocá todo lo que no reconozcas, que ya no uses o cuyo token pudo quedar expuesto. Si lazyit te manda
el aviso **Nuevo agente de IA conectado** y no fuiste vos, revocalo acá enseguida, cambiá tu
contraseña y avisale a tu administrador.

## Tokens personales

En una instancia sin dirección HTTPS — por ejemplo HTTP plano (modo LAN) — las apps de IA se conectan
con tokens personales en vez de iniciar sesión con OAuth (mirá
[Cómo se conectan las apps](/help/ai-assistant-claude-code-mcp#cómo-se-conectan-las-apps-oauth-o-tokens-personales)).
Ahí, **Apps conectadas** tiene un botón **Crear token**.

1. Hacé clic en **Crear token**.
2. Poné un **nombre** que después reconozcas ("Claude Code en mi laptop").
3. Elegí cuándo **vence** — 30, 90 (por defecto), 180 o 365 días. Elegí el plazo más corto que te sirva.
4. Elegí su **acceso**: **Solo lectura** o **Lectura y escritura**. Las acciones de administración
   nunca están disponibles para un token personal.
5. Hacé clic en **Crear token** y **copialo o descargalo en el momento**. Se muestra **una sola vez**:
   lazyit guarda solo una huella. Si lo perdés, revocalo y creá otro.

Dale el token a tu app — Claude Code te lo pide al activar el plugin de lazyit; otros clientes lo mandan
en una cabecera `Authorization: Bearer …`, nunca en la dirección. Tratalo como una contraseña: actúa
como vos hasta que vence o lo revocás.

Podés tener hasta **20** tokens personales activos. En una instancia HTTPS no se pueden crear — las apps
inician sesión con OAuth. Los tokens creados antes de que una instancia pasara a HTTPS dejan de
funcionar ahí, pero siguen en la lista hasta que vencen para que los puedas revocar.

## Qué termina una conexión

| Evento | Efecto en tus apps y tokens |
| --- | --- |
| **Revocás** una | Esa deja de funcionar para siempre. |
| **Cerrás sesión** en lazyit | **Nada** — las conexiones son de tu cuenta, no de tu sesión en el navegador. |
| Tu **contraseña cambia** o se restablece | **Todas** las apps y tokens dejan de funcionar y desaparecen de la lista. Reconectalas después. |
| Tu cuenta se **desactiva o se da de baja** | **Todas** las apps y tokens dejan de funcionar. |
| Tu rol **pierde un permiso** | Tus apps también — una conexión nunca tiene más acceso que vos. |
| Un administrador desactiva **Agentes de IA externos (MCP)** | Todas las conexiones quedan **en pausa**, y vuelven a funcionar al reactivar MCP. |
| Un token llega a su **vencimiento** | Deja de funcionar; creá uno nuevo. |

## Para administradores

Todavía no hay una página para revisar las conexiones de otras personas. Para cortarle el acceso a
alguien, desactivá o da de baja la cuenta, o restablecé su contraseña — cualquiera de las tres termina
todas sus conexiones. Para frenar todas las conexiones de la instancia a la vez, desactivá **Agentes de
IA externos (MCP)** en **Configuración → IA** (quedan en pausa). La API ya lista y revoca las conexiones
de cualquier persona para un administrador con sesión iniciada (`GET` / `DELETE /api/oauth/grants`);
todavía no hay una pantalla para eso.

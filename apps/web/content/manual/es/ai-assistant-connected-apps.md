---
title: Apps conectadas y tokens personales
order: 1
category: ai-assistant
subcategory: connected-apps
---

# Apps conectadas y tokens personales

Cada app de IA que puede actuar en tu nombre aparece en **Apps conectadas**, dentro de **IA y apps
conectadas** (menú de usuario → **IA y apps conectadas**, en `/account/ai`). Desde ahí revisas qué está
conectado y cortas el acceso a cualquier cosa que no reconozcas.

## Qué muestra la lista

Cada fila es una conexión:

- **Apps** que aprobaste en la [pantalla de consentimiento](/help/ai-assistant-claude-code-mcp), con su
  nombre (marcada **Sin verificar** cuando lazyit no pudo confirmar quién la publica) y la dirección por
  la que inicia sesión.
- **Tokens personales** que creaste, con el nombre que les diste.

Para cada una ves qué puede hacer (**Lectura**, **Escritura**, **Admin**), cuándo se conectó, cuándo se
**usó por última vez** y, en un token personal, cuándo **caduca**.

## Revocar

Haz clic en **Revocar** y confirma. La app o el token pierde el acceso en su **próxima solicitud**; una
app debe aprobarse de nuevo para reconectarse, y un token revocado no se puede recuperar.

Revoca lo que no reconozcas, lo que ya no uses y cualquier token que pueda haber quedado expuesto.
Cuando lazyit te avise de que **una nueva app de IA se conectó a tu cuenta** y no fuiste tú, revócala
aquí de inmediato y avisa a tu administrador.

> Apagar el servidor MCP en Ajustes → IA solo **pausa** las conexiones: vuelven a funcionar cuando se
> enciende de nuevo. Para quitarle el acceso a una app definitivamente, revócala.

## Tokens personales

En una instancia servida por **HTTP sin cifrar** (modo LAN), las apps de IA se conectan con tokens
personales en lugar de iniciar sesión con OAuth; consulta
[Claude Code y MCP](/help/ai-assistant-claude-code-mcp). Ahí, **Apps conectadas** tiene un botón **Crear
token**.

1. Haz clic en **Crear token**.
2. Dale un **nombre** que reconozcas después (por ejemplo, «Claude Code en mi portátil»).
3. Elige cuándo **caduca**: 30, 90 (por defecto), 180 o 365 días. Todo token caduca; elige el plazo más
   corto que necesites.
4. Elige su **acceso**: **Solo lectura** o **Lectura y escritura**. Las acciones de administración nunca
   están disponibles para un token personal.
5. Haz clic en **Crear token** y **copia o descarga el token en ese momento**. Se muestra **una sola
   vez**: lazyit solo guarda una huella y no puede volver a mostrarlo. Si lo pierdes, revócalo y crea
   otro.

Dale el token a tu app de IA; Claude Code lo pide al activar el plugin de lazyit. Trátalo como una
contraseña: actúa en tu nombre hasta que caduca o lo revocas.

Puedes tener hasta **20** tokens personales activos. En una instancia HTTPS no se pueden crear tokens
personales: las apps inician sesión con OAuth. Los tokens creados antes de que una instancia pasara a
HTTPS dejan de funcionar allí, pero siguen en la lista hasta que caducan para que puedas revocarlos.

## Bueno saber

- Una conexión nunca tiene más acceso que tú: si tu rol pierde un permiso, tus apps también.
- Cerrar sesión en lazyit desde tu navegador **no** desconecta tus apps: las conexiones y los tokens
  personales siguen funcionando. Todos dejan de funcionar —y desaparecen de la lista— cuando cambia tu
  contraseña, cuando cierras sesión **en todas partes** (todos los dispositivos) o cuando se desactiva o
  da de baja tu cuenta. Después vuelve a conectar tus apps (o crea tokens nuevos). Para cortar el acceso
  a una sola app, revócala aquí.
- Los administradores pueden ver y revocar las apps conectadas de todos los usuarios en **Ajustes → IA**.

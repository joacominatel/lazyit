---
title: Correo y SMTP
category: configuration
subcategory: smtp-email
order: 4
---

# Correo y SMTP

lazyit puede enviar **correo saliente** para que un conjunto seleccionado de sus notificaciones también
llegue a la bandeja de entrada de tu equipo, y no solo a la **campana de notificaciones** dentro de la
app. Debes apuntar lazyit a tu servidor de correo (SMTP) existente en **Ajustes → Instancia → SMTP**
(solo administradores). Está **desactivado hasta que lo actives**.

## Configurar la conexión

El editor de SMTP tiene estos campos:

- **Activado** — el interruptor maestro del correo saliente. Mientras está desactivado, lazyit nunca
  envía correos de notificación (aun así puedes enviar una prueba — ver más abajo).
- **Host** y **Puerto** — la dirección de tu servidor de correo (p. ej. `smtp.example.com`, puerto
  `587`).
- **Seguridad** — cómo se protege la conexión:
  - **STARTTLS** (recomendado, normalmente puerto `587`) — conecta en texto plano y luego actualiza a
    TLS.
  - **TLS implícito** (normalmente puerto `465`) — cifrado desde el primer byte.
  - **Ninguna** — texto plano, sin cifrado. Solo para un servidor interno de confianza.
- **Usuario** — el usuario de SMTP. Déjalo en blanco para un servidor abierto/sin autenticación en una
  red de confianza.
- **Contraseña** — la contraseña de SMTP. Es de **solo escritura**: una vez guardada, lazyit solo indica
  que hay una contraseña **configurada** y nunca vuelve a mostrarla. Deja el campo en blanco al editar
  para **conservar** la contraseña guardada; escribe un valor nuevo solo para cambiarla.
- **Dirección de origen** y **Nombre de origen** — la dirección (y el nombre opcional) desde la que se
  envían tus correos.
- **Rechazar certificados TLS no verificados** — activado por defecto (seguro). Desactívalo solo si tu
  servidor usa un certificado autofirmado en el que confías.

> La contraseña se guarda **cifrada en reposo**. Guardar una contraseña requiere que la clave del
> servidor `SMTP_SECRET_KEY` esté configurada; si no lo está, lazyit guarda el resto de los ajustes y te
> avisa de que primero configures la clave. Consulta la configuración de entorno de tu despliegue.

## Enviar un correo de prueba

Usa **Enviar correo de prueba** para confirmar que todo funciona antes de depender de ello. Introduce una
dirección de destino y lazyit envía un mensaje real usando los ajustes **guardados actualmente** — así
que **guarda primero** y luego prueba. **No** necesitas activar el correo saliente para probar. Si el
servidor rechaza el mensaje, lazyit muestra un error breve (por ejemplo, «conexión rechazada» o «fallo de
autenticación») en lugar de fallar en silencio.

## Qué notificaciones se envían por correo

Cuando el correo saliente está activado, lazyit envía por correo un pequeño conjunto seleccionado de
notificaciones **operativas** — las mismas que aparecen en la campana:

- **Stock bajo** — un consumible llegó a su mínimo o por debajo.
- **Un flujo de trabajo necesita una persona** y **una ejecución de flujo de trabajo falló**.
- **Se concedió acceso a una aplicación crítica** y **un usuario fue elevado a administrador**.
- **Un cambio de permiso sensible** y **un agente de reportes que se desconecta** (las alertas de auditoría sensible).

Cada correo llega a las **mismas personas que ven esa notificación en la campana**: una difusión llega a
tus administradores; una notificación dirigida a una persona llega a esa persona. Los correos de difusión
usan **Cco** para que los destinatarios no vean las direcciones de los demás. El aviso de configuración de
la bóveda al iniciar sesión permanece **solo en la campana**.

> El correo es **de mejor esfuerzo**: si tu servidor está caído o mal configurado, la notificación dentro
> de la app igual aparece y nada más se rompe — el correo simplemente se reintenta unas cuantas veces y
> luego se descarta. El correo es un canal de conveniencia, no el registro autoritativo.

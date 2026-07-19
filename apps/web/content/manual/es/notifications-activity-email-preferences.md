---
title: Correos de notificación
order: 1
category: notifications-activity
subcategory: email-preferences
---

# Correos de notificación

Cualquier persona con sesión iniciada puede elegir de qué notificaciones lazyit le envía **correo**. Es
un ajuste personal, por persona: cambia solo tu propia bandeja de entrada, nunca la de otros, y **no**
afecta a la [campana de notificaciones](/help/notifications-activity-notification-bell) dentro de la app
— allí sigues viendo todas las notificaciones.

## Abrir tus preferencias

Abre el **menú de usuario** (tu avatar en la esquina superior derecha) y elige **Correos de
notificación**. La página está en `/account/notifications` y está disponible para todos — no hace falta
ningún permiso especial.

## Cómo funcionan los interruptores

La página muestra un interruptor por cada tipo de notificación que tu instancia te puede enviar por
correo:

- **Activado** — recibes un correo cuando se dispara esa notificación.
- **Desactivado** — dejas de recibir correos de ese tipo. La notificación sigue apareciendo en tu
  campana.

Cada interruptor **se guarda en el momento en que lo cambias** — no hay un botón Guardar aparte. Si el
guardado falla, el interruptor vuelve a su posición anterior y un mensaje de error explica qué pasó.

## Qué interruptores ves

La lista se **arma para ti**, no es fija. Un tipo solo aparece cuando tu instancia realmente puede
enviarlo por correo, lo que depende de dos cosas:

- **El correo debe estar configurado.** Si tu administrador no configuró el correo saliente (SMTP), no
  hay nada que enviar y la página te avisa que no hay nada que configurar. Consulta
  [SMTP y correo](/help/configuration-smtp-email).
- **La notificación debe llegarte.** La mayoría de las notificaciones son solo para administradores, así
  que una persona no administradora ve únicamente los tipos que efectivamente se le envían.

Como la lista es a medida, dos personas pueden ver interruptores distintos — es lo esperado.

## Qué significa cada tipo

Los tipos disponibles reflejan los disparadores de la campana — una concesión a una aplicación crítica,
una elevación a administrador, stock bajo, un flujo que necesita a una persona o que falló, una concesión
de permiso sensible, un agente de reportes desconectado, una nueva versión de lazyit, la decisión sobre
una de tus propias solicitudes de acceso, o un aviso anticipado de que una garantía de activo o una
concesión de acceso está por vencer. Cada interruptor lleva una descripción de una línea para que
sepas exactamente qué silenciarás al desactivarlo. Para la
lista completa de disparadores, consulta la
[campana de notificaciones](/help/notifications-activity-notification-bell).

## Bueno saberlo

- Desactivar un tipo **nunca** lo oculta de tu campana ni del historial de actividad — solo detiene la
  copia por correo.
- Los tipos de notificación nuevos que se agreguen en una versión futura empiezan **activados** (con
  correo) para que nunca te pierdas una señal nueva por sorpresa; desactiva aquí el que prefieras.

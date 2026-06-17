---
title: Tareas manuales
order: 3
category: access-automation
subcategory: manual-tasks
---

# Tareas manuales

No todos los pasos de aprovisionamiento se pueden automatizar. Una **tarea manual** es un paso que
**pausa la ejecución** y pide a una persona que actúe, y luego se reanuda cuando esa persona termina.
lazyit crea una tarea manual en dos casos:

- Un paso de **Tarea humana** en el flujo (un paso deliberado de «esto debe hacerlo una persona» — por
  ejemplo, «decidir a qué equipo añadir a este usuario»).
- Un **Fallo escalado** — un paso API o webhook falló y su arista **Al fallar** estaba configurada
  como *Escalar a una persona*.

Mientras una ejecución está pausada permanece en el estado **Esperando (manual)** y no consume nada;
sigue pausada hasta que una persona completa la tarea — no hay ninguna presión de tiempo para actuar
de inmediato.

## La bandeja de tareas manuales

Las tareas manuales pendientes de todas las aplicaciones se agrupan en una **bandeja**, a la que se
llega desde **Configuración → Integraciones**. La bandeja lista cada tarea con su **Paso**, su origen
(Paso manual o Fallo escalado) y su **Antigüedad**. La campana de notificaciones avisa a las personas
adecuadas cuando aparece una tarea, así que no tienes que estar pendiente de la bandeja.

## Completar una tarea

Abre una tarea para ver **qué pasó** (el paso y por qué se pausó la ejecución) y **tu entrada** — los
campos tipados que el autor del flujo definió para que los rellenes (texto, número, sí/no, o una
opción de un desplegable). Tienes tres acciones:

- **Enviar** — aportar la entrada solicitada. La ejecución **se reanuda** desde donde se pausó y
  continúa por los pasos restantes.
- **Omitir paso** — saltar este paso y continuar la ejecución sin él.
- **Fallar ejecución** — detener la ejecución como fallida. Puedes registrar un breve **motivo**. La
  concesión nunca se toca — fallar la ejecución solo detiene la automatización.

Después de actuar, la tarea queda marcada como **Completada** (o **Cancelada**) y se muestra como
resuelta; no se puede actuar sobre ella dos veces.

## Quién puede actuar

Completar una tarea requiere el permiso **`workflow:task`** **y** que seas un destinatario permitido —
el permiso por sí solo no basta si la tarea está asignada a una persona o grupo concretos. Si no
tienes permiso para una tarea, el formulario te lo indica y queda deshabilitado. Consulta
[Permisos](/help/access-automation-permissions).

> Los valores que escribes se tratan como entrada simple — rellenan los campos que el autor del flujo
> mapeó, y nunca se ejecutan como código ni como expresiones.

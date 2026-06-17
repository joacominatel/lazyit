---
title: Asignaciones e historial
category: assets
subcategory: assignments-history
order: 1
---

# Asignaciones e historial

La pertenencia en lazyit **no** es un campo que sobrescribes — es un registro de quién tuvo un activo
y cuándo. Eso es lo que mantiene al activo como el registro principal: las personas rotan, los activos
permanecen y el rastro completo de pertenencia se conserva automáticamente. Los responsables se
gestionan desde la página de detalle del activo, en **Responsables**.

## Asignar un responsable

Abre un activo, ve a **Responsables** y elige **Asignar usuario**. Elige a la persona y agrega una nota
opcional (por ejemplo "notebook principal de trabajo"). El activo pasa a listar a esa persona como
**responsable activo**.

Algunas cosas a tener en cuenta:

- **Un activo puede tener varios responsables a la vez.** lazyit admite pertenencia compartida y
  simultánea — por ejemplo un servidor del que varias personas son responsables. Asignar un segundo
  responsable no desplaza al primero.
- **Una asignación activa por persona y activo.** No puedes asignar a la misma persona al mismo activo
  dos veces mientras la primera asignación siga activa — libérala primero.
- Solo puedes asignar un activo **vigente** a un usuario **vigente** — los activos y usuarios
  desactivados no pueden recibir nuevas asignaciones.

## Liberar un responsable

Para terminar la pertenencia de alguien, elige **Liberar** junto a ese responsable. Liberar a un
responsable no afecta a los demás. Puedes agregar una nota explicando el motivo (por ejemplo una
devolución o una entrega).

Liberar **no** borra la asignación — le pone una fecha de liberación y la mueve al historial de
pertenencia. Esto es deliberado: no hay una acción de "borrar asignación", porque el objetivo es
conservar el registro. Para pasar un activo de una persona a otra, **libera** al responsable anterior
y **asigna** al nuevo.

> Un responsable que dejó la empresa sigue figurando como responsable activo hasta que liberes
> explícitamente la asignación — lazyit nunca descarta registros de pertenencia en silencio.

## Actividad e historial de pertenencia

Cada activo lleva un **registro de actividad de solo adición** — una línea de tiempo de eventos
discretos, del más reciente al más antiguo. El registro es inmutable: las entradas se escriben, nunca
se editan ni se borran. Lo encuentras en la página de detalle del activo bajo **Actividad**, y las
entradas específicas de pertenencia bajo **Historial de pertenencia**.

Los eventos registrados incluyen:

- **Creado** y **Eliminado** / **Restaurado** — el ciclo de vida del activo.
- Cambios de **Estado** — por ejemplo Operativo → En mantenimiento.
- Cambios de **Ubicación** y **Modelo**.
- Cambios de **Specs** — ediciones de los campos personalizados.
- **Asignado** y **Liberado** — cambios de pertenencia, nombrando al responsable involucrado.

Cada entrada registra **qué cambió, cuándo y quién lo hizo** (o "Sistema" cuando lazyit actuó por su
cuenta). Junto con el borrado lógico en todo el sistema, esto te da el rastro de auditoría de toda la
vida de un activo sin trabajo extra.

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — registra y edita activos.
- [Ubicaciones](/help/assets-locations) — controla dónde reside un activo.

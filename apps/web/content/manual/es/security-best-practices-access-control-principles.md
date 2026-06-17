---
title: Principios de control de acceso
category: security-best-practices
subcategory: access-control-principles
order: 2
---

# Principios de control de acceso

El modelo de acceso de lazyit es pequeño a propósito: **tres roles fijos** y un **conjunto
configurable de permisos** detrás de cada uno (consulta [Permisos](/help/permissions) para el
panorama completo). Esta página cubre los principios a tener en cuenta cuando decides quién obtiene
qué.

## Empieza a las personas en solo lectura, luego promociónalas

Los usuarios nuevos parten como **Lector** — solo lectura. Esto es deliberado: una identidad nueva
debería poder mirar pero no cambiar nada hasta que alguien decida lo contrario. Asciende a una
persona a **Miembro** o **Administrador** cuando su trabajo lo necesite, no de forma preventiva.

La única excepción es el **primerísimo usuario de una instalación nueva**, que se convierte en
**Administrador** para que la instancia nunca quede sin uno. Toda cuenta creada después de esa empieza
como Lector.

## Mínimo privilegio: concede el rol más pequeño que funcione

Da a cada persona **lo mínimo** que necesita para su trabajo:

- **Lector** para quienes solo necesitan mirar — auditores, usuarios ocasionales, cualquiera de solo
  lectura.
- **Miembro** para el rol de trabajo cotidiano — crear y actualizar activos, aplicaciones,
  consumibles y la Base de Conocimiento.
- **Administrador** solo para el reducido número de personas que realmente operan la instancia.

Administrador es el rol más poderoso y el que deberías repartir con más cuidado. Menos
administradores significa menos cuentas cuya filtración sería grave.

## Administrador es todo o nada — y siempre conservas uno

Dos reglas sobre Administrador vale la pena entender antes de ajustar permisos:

- **Administrador no se puede reducir.** Un administrador siempre tiene todos los permisos; no puedes
  editar el conjunto de permisos del Administrador. Esto es deliberado — siempre hay un administrador
  con plena capacidad para operar la instancia.
- **Siempre hay al menos un administrador.** lazyit no te dejará quitar ni degradar al último. No
  puedes dejar por accidente a todo el equipo sin administración.

Como Administrador es todo o nada, el patrón seguro **no** es "dale admin a esta persona para una
tarea". Es: mantenla como Miembro y **concédele el permiso de Miembro concreto** que necesita.

## Ajusta a Miembro y Lector — no editando registros

Lo que **sí** puedes cambiar es qué permisos tienen **Miembro** y **Lector**, desde la configuración
de permisos por rol. Algunos de esos permisos —eliminar registros, conceder acceso a aplicaciones—
son de nivel administrador por defecto; cuando le entregas uno a Miembro o Lector, lazyit lo señala y
te pide confirmar, porque es una delegación con peso. No te lo impide; solo se asegura de que la
elección sea intencional.

> Los permisos son sobre **áreas del producto**, no sobre registros individuales. Si un rol puede leer
> activos, puede leer todos los activos. lazyit no tiene control de acceso por registro de forma
> general — las dos excepciones deliberadas son las **carpetas de la Base de Conocimiento** y las
> **bóvedas del Gestor de Secretos**, donde el acceso se limita a una carpeta o a una bóveda.

## Sin escalada: no puedes repartir un acceso que no tienes

Un principio que recorre todo el producto: **no puedes conceder un acceso que tú mismo no tienes.**

- Solo puedes agregar a alguien a una **bóveda del Gestor de Secretos** de la que tú eres miembro —
  no puedes compartir secretos que tú mismo no puedes leer.
- No puedes usar un enlace o un alias de la **Base de Conocimiento** para ampliar quién ve un artículo
  al que tú mismo no tienes acceso.

Esto significa que el acceso solo puede fluir *hacia abajo* desde quienes ya lo tienen — no hay puerta
lateral para escalar a través de compartir.

## Las cuentas de servicio son a prueba de fallos cerrados

Si automatizas contra lazyit con una **cuenta de servicio** (un token no humano), sigue una regla más
estricta que las personas: puede hacer **solo** lo que se le concedió explícitamente, nada más, y
nunca puede ser administrador. Dale a cada automatización su propia cuenta de servicio con el conjunto
de permisos más estrecho que su tarea necesite, y rota su token si pudo quedar expuesto. Consulta la
sección de Usuarios y permisos para gestionar cuentas de servicio.

## Una regla práctica sencilla

Ante la duda, concede el rol **más pequeño** y agrega un **permiso concreto** si resulta necesario.
Es fácil conceder más después; es más difícil notar que alguien tuvo demasiado acceso durante meses.

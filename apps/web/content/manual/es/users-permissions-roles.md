---
title: Roles
category: users-permissions
subcategory: roles
order: 1
---

# Roles

lazyit incluye **tres roles fijos**: **Administrador**, **Miembro** y **Lector**. Cada usuario tiene
exactamente uno. No puedes crear, renombrar ni eliminar roles — el conjunto es el mismo en cada
instalación, lo que mantiene el modelo pequeño y predecible para un equipo de IT reducido.

Un rol es el *nivel* de acceso de una persona. Lo que ese nivel le permite hacer en realidad lo
deciden los **permisos** (ver [Permisos](/help/permissions)), y para Miembro y Lector esos permisos se
pueden ajustar. El rol es lo que un usuario *tiene*; los permisos son lo que un rol *otorga*.

## Los tres roles

- **Administrador** — control total de la instancia. Un administrador puede hacer todo: gestionar
  usuarios y sus roles, cambiar la configuración, eliminar registros, conceder y revocar acceso a
  aplicaciones, y ajustar lo que pueden hacer Miembro y Lector. El administrador **siempre tiene todos
  los permisos** y ese conjunto nunca es editable — así se garantiza que la instancia siempre pueda ser
  operada por alguien con plena capacidad.
- **Miembro** — el rol de trabajo cotidiano. Por defecto un Miembro puede leer y crear/editar la
  mayoría de las cosas (activos, aplicaciones, consumibles, la Base de Conocimiento, ubicaciones,
  modelos, categorías), pero no puede eliminar registros ni realizar acciones reservadas al
  administrador.
- **Lector** — solo lectura. Por defecto un Lector puede mirar la mayoría de las áreas pero no cambiar
  nada. Además, algunas vistas sensibles (el directorio de usuarios y el registro de concesiones de
  acceso) quedan ocultas para el Lector por defecto.

## La vista general de Roles

**Configuración → Roles** muestra una tarjeta por rol con, para cada uno: un **conteo de miembros en
vivo** (cuántos usuarios activos lo tienen), un recordatorio breve de lo que el rol puede hacer y un
enlace **Ver N miembros**. Ese enlace abre la [lista de Usuarios](/help/users-permissions-user-lifecycle)
filtrada por ese rol — la lista de Usuarios es donde realmente navegas y gestionas quién lo tiene, con
búsqueda, orden y paginado. Las tarjetas solo muestran conteos; ya no listan a los miembros en línea.
Desde las mismas tarjetas puedes abrir **Editar permisos** para Miembro y Lector (Admin tiene acceso
completo y está bloqueado).

## Cómo se asigna un rol

- **El primer usuario siempre es Administrador.** La primera persona que se provisiona en una
  instalación nueva —ya sea mediante el asistente de configuración o el primer inicio de sesión— se
  convierte en Administrador, para que una instancia nueva nunca quede sin administrador.
- **Todos los demás empiezan como Lector.** Los usuarios recién provisionados se asignan al rol de
  menor privilegio (solo lectura) hasta que un administrador los promueve. Es deliberado: una identidad
  nueva puede mirar pero no cambiar nada hasta que alguien le otorgue más.
- **Los administradores cambian los roles desde la sección de Usuarios.** Abre un usuario (o usa la
  celda de rol en la lista de Usuarios) y elige **Administrador**, **Miembro** o **Lector**. lazyit te
  pide que confirmes el cambio.

## Reglas de seguridad incorporadas

Dos salvaguardas protegen la instancia de quedar bloqueada o de una escalada silenciosa:

- **No se puede quitar al último administrador.** lazyit se niega a degradar, desactivar o dar de baja
  al último administrador que queda — siempre debe haber al menos uno. Verás un mensaje claro en lugar
  de que el cambio se aplique.
- **No puedes cambiar tu propio rol.** Un administrador no puede promoverse ni degradarse a sí mismo; un
  cambio de rol debe hacerlo un administrador sobre otro. Esto evita que una sola persona eleve su
  propio acceso en silencio. (Sí puedes editar tu propio nombre, correo y otros datos.)

## Una nota sobre tu proveedor de identidad

Si usas tu propio proveedor de identidad (BYOI), los roles se gestionan **localmente en lazyit** — no
se leen de un token y se usan solo para la autorización dentro de la app. lazyit guarda su propia copia
del rol; tú lo asignas y lo cambias aquí, en la sección de Usuarios.

Para el detalle completo de lo que puede hacer cada rol —y cómo ajustar a Miembro y Lector— consulta
[Permisos](/help/permissions) y
[Configuración de permisos](/help/users-permissions-permission-configuration).

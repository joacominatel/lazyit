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
  administrador. Un Miembro también puede usar el [asistente de IA](/help/ai-assistant-overview) y
  conectar agentes de IA externos, una vez que un administrador los activa — siempre con los permisos
  del propio Miembro.
- **Lector** — solo lectura. Por defecto un Lector puede mirar la mayoría de las áreas pero no cambiar
  nada. Además, algunas vistas sensibles (el directorio de usuarios, el registro de concesiones de
  acceso y las compras y proveedores) quedan ocultas para el Lector por defecto.

## La página de Roles y permisos

**Configuración → Roles y permisos** es una sola matriz: lo que puede hacer cada rol, con el
Administrador como columna de referencia bloqueada junto a las columnas editables de Miembro y Lector.
El encabezado de cada columna muestra un **conteo de miembros en vivo** (cuántos usuarios activos tienen
ese rol); haz clic para abrir la [lista de Usuarios](/help/users-permissions-user-lifecycle) filtrada por
ese rol — la lista de Usuarios es donde realmente navegas y gestionas quién lo tiene, con búsqueda, orden
y paginado. Cómo editar lo que pueden hacer Miembro y Lector se describe en
[Configuración de permisos](/help/users-permissions-permission-configuration). (La dirección antigua del
editor por rol, `/settings/roles/permissions`, ahora abre esta página.)

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

Estas salvaguardas protegen la instancia de quedar bloqueada o de una escalada silenciosa:

- **No se puede quitar al último administrador.** lazyit se niega a degradar, desactivar o dar de baja
  al último administrador que queda — siempre debe haber al menos uno. Verás un mensaje claro en lugar
  de que el cambio se aplique. Solo cuentan los administradores que realmente pueden iniciar sesión: un
  administrador que nunca inició sesión con tu proveedor de identidad, un administrador sin contraseña en
  una instalación con cuentas locales o una persona del directorio no mantienen la instancia
  administrable.
- **Nadie gestiona usuarios por encima de su propio rol.** Si le das a Miembro o a Lector la capacidad
  **Gestionar usuarios**, esas personas solo pueden otorgar su propio rol o uno inferior, y solo pueden
  editar, restablecer, dar de baja o restaurar a usuarios con un rol igual o inferior al suyo. Solo un
  administrador puede crear un administrador, promover a alguien a administrador o actuar sobre un
  administrador existente. Los selectores de rol solo muestran los roles que puedes otorgar, y en un
  usuario por encima de tu rol el rol aparece como una etiqueta fija y no se ofrecen **Editar**, el
  restablecimiento de contraseña ni **Dar de baja** (clonarlo sí). Cualquier otra cosa se rechaza con
  un mensaje claro.
- **Solo un administrador edita los permisos y la conexión del directorio.** Dar a Miembro o a Lector
  **Cambiar la configuración de la instancia** les permite ver la matriz de permisos y la conexión del
  directorio, no cambiarlas ni ejecutar una sincronización del directorio.
- **Promover a alguien cancela sus credenciales de acceso pendientes.** Cuando el rol de una persona
  sube, se cancelan la contraseña temporal que todavía no reemplazó y cualquier enlace de
  restablecimiento pendiente, así que una entregada con el rol inferior deja de funcionar. La
  confirmación del cambio de rol te avisa antes y el mensaje de éxito te lo recuerda. Si la necesita,
  emite una nueva contraseña temporal o un nuevo enlace después de la promoción.
- **No puedes cambiar tu propio rol.** Un administrador no puede promoverse ni degradarse a sí mismo; un
  cambio de rol debe hacerlo un administrador sobre otro. Esto evita que una sola persona eleve su
  propio acceso en silencio. (Sí puedes editar tu propio nombre, correo y otros datos.)
- **El rol de una persona del directorio no se puede cambiar.** Las personas que llegan por una
  importación o por la sincronización del directorio no tienen inicio de sesión y siguen siendo
  **Lector** hasta que se las incorpora. Su rol aparece bloqueado, con el motivo; incorpóralas primero
  y luego cambia el rol.

## Una nota sobre tu proveedor de identidad

Los roles se gestionan **localmente en lazyit**, sea cual sea la forma de iniciar sesión. Con tu propio
proveedor OIDC no se leen de un token ni se envían nunca al proveedor; se usan solo para la autorización
dentro de la app. Tú los asignas y los cambias aquí, en la sección de Usuarios.

Para el detalle completo de lo que puede hacer cada rol —y cómo ajustar a Miembro y Lector— consulta
[Permisos](/help/permissions) y
[Configuración de permisos](/help/users-permissions-permission-configuration).

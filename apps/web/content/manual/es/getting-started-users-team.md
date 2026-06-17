---
title: Usuarios y equipo
order: 1
category: getting-started
subcategory: users-team
---

# Usuarios y equipo

Una vez que inicias sesión como administrador, das de alta al resto de tu equipo desde el área de
**Usuarios**. Cada persona obtiene una cuenta de lazyit con un rol y — en el inicio de sesión
integrado — una contraseña de un solo uso que le entregas para que pueda entrar.

## Agregar un usuario

Abre **Usuarios** y elige **Nuevo usuario** para abrir el formulario de alta. Tiene tres partes:

- **Identidad** — nombre, apellido y correo son obligatorios. El correo es la identidad de la persona,
  así que debe ser único. Los campos opcionales te permiten registrar un nombre de usuario, un legajo
  y un responsable.
- **Rol** — elige **Admin**, **Miembro** o **Lector**. Los usuarios nuevos quedan como **Lector** (de
  solo lectura) por defecto — mínimo privilegio. Los Admin tienen acceso total, incluida la
  administración de usuarios; los Miembros realizan las operaciones normales de inventario, Base de
  Conocimiento y activos; los Lectores son de solo lectura en todas partes. Puedes cambiar el rol más
  tarde. Consulta [Permisos](/help/permissions) para el detalle completo.
- **Ventaja inicial (opcional)** — puedes asignar un activo o conceder acceso a una aplicación desde
  el propio formulario, para que la persona empiece con algo en mano. Siempre puedes hacerlo después.

Selecciona **Crear usuario** para terminar.

## La entrega de la contraseña temporal

En el **inicio de sesión integrado**, el formulario incluye una sección de **Credencial de inicio de
sesión** donde defines una **contraseña temporal**. Usa **Generar** para producir una segura (debe
cumplir la lista de verificación en vivo: longitud, más una mayúscula, una minúscula, un número y un
símbolo).

Después de crear el usuario, lazyit muestra la contraseña temporal **una sola vez** para que la copies
y la entregues — no se vuelve a mostrar, así que cópiala antes de salir de la pantalla. lazyit nunca
almacena esta contraseña: se define en el servicio de inicio de sesión y se reemplaza en cuanto el
usuario nuevo inicia sesión, porque está **obligado a elegir la suya en el primer inicio de sesión**.

> Si tu instancia usa **tu propio proveedor de identidad** (BYOI), la sección de credencial no aparece
> y no se define ni se envía ninguna contraseña — tu proveedor es el dueño de la credencial. Un aviso
> en la página de Usuarios te recuerda que los usuarios y roles que gestionas aquí son *locales de
> lazyit* y no se escriben de vuelta en tu proveedor; crea y desactiva cuentas en tu IdP, y lazyit
> mantiene su propia copia para la autorización.

## Qué ocurre en el primer inicio de sesión

Cuando una persona inicia sesión por primera vez, lazyit vincula la sesión a su cuenta de lazyit y
entra a la app con el rol que definiste.

Con **tu propio proveedor de identidad**, lazyit también puede aprovisionar una cuenta de forma
*automática* en el primer inicio de sesión (just-in-time), aunque no hayas dado de alta a la persona
antes. Si ya existe una cuenta coincidente por **correo verificado**, el primer inicio de sesión se
vincula a ella en vez de crear un duplicado. Las cuentas aprovisionadas automáticamente también
empiezan como **Lector** por defecto. Esto significa que el control de quién llega a lazyit es tu
proveedor de identidad: quien pueda iniciar sesión allí puede obtener una cuenta (de solo lectura)
aquí, salvo que le quites el acceso en el origen.

## Gestionar a las personas existentes

Desde la página de detalle de un usuario puedes editar su identidad, cambiar su rol, restablecer su
contraseña (en el inicio de sesión integrado) y darlo de baja cuando se va. La baja archiva la cuenta
en lugar de eliminarla, así que el historial de la persona — asignaciones y actividad pasadas — se
conserva.

## Pasos siguientes

- Ajusta quién puede hacer qué: [Permisos](/help/permissions).
- Configura bóvedas de credenciales compartidas: [Gestor de Secretos](/help/secret-manager).

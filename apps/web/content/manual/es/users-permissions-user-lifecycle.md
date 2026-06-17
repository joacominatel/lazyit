---
title: Ciclo de vida del usuario
category: users-permissions
subcategory: user-lifecycle
order: 5
---

# Ciclo de vida del usuario

Esta página cubre toda la vida de una persona en lazyit: crearla, darle un rol y un punto de partida,
clonar a un colega existente, enviar un restablecimiento de contraseña, darla de baja y restaurarla.
Todo esto vive en la sección de **Usuarios** y requiere la capacidad **Gestionar usuarios**
(administrador por defecto).

## Crear un usuario

Elige **Nuevo usuario** y completa la identidad de la persona:

- **Nombre y apellido**, y **Correo** — el correo es la clave de vinculación de cuenta con tu proveedor
  de identidad, debe ser único, y un cambio se refleja en el proveedor.
- **Rol** — por defecto es solo lectura; defínelo aquí o cámbialo más tarde. Ver
  [Roles](/help/users-permissions-roles).
- **Número de empleado** y **Nombre de usuario** (ambos opcionales) — datos de directorio, únicos entre
  los usuarios activos. El nombre de usuario es un identificador, **no** una credencial de inicio de
  sesión.
- **Responsable** (opcional) — un usuario de lazyit existente **o** un nombre de texto libre, no ambos.

**Credencial de inicio de sesión.** Cuando lazyit gestiona las credenciales (el proveedor de identidad
incluido), defines una **contraseña temporal** para que la persona pueda iniciar sesión; ella elige la
suya en el primer inicio. lazyit nunca guarda esta contraseña — se define en el proveedor de identidad
y se reemplaza cuando el usuario inicia sesión, y se muestra una sola vez para la entrega. Si usas tu
propio proveedor de identidad, este paso no aparece — gestiona la credencial en tu proveedor.

**Punto de partida (opcional).** Puedes asignar un activo y conceder acceso a una aplicación desde el
mismo formulario de creación, para que la persona empiece con lo que necesita.

## Clonar un usuario

Para incorporar a alguien que replica a un colega ("el mismo acceso que Ana"), abre un usuario y elige
**Clonar**. Eliges un correo nuevo y único y un rol, y luego seleccionas cuáles de los **activos** y del
**acceso a aplicaciones** del origen se trasladan.

Por defecto, el acceso clonado **solo se registra** — es contabilidad, sin efecto externo. Hay un
interruptor opcional para **aprovisionar al nuevo usuario en estas aplicaciones**, que ejecuta los
flujos de aprovisionamiento de las apps seleccionadas. Tras clonar, lazyit te indica qué se trasladó y
enumera lo que se omitió (y por qué).

## Enviar un restablecimiento de contraseña

En la página de detalle de un usuario, **Enviar restablecimiento de contraseña** pide a tu proveedor de
identidad que envíe por correo a la persona un enlace de restablecimiento. lazyit nunca ve ni define la
contraseña — solo dispara al proveedor, y la entrega depende de que el correo del proveedor esté
configurado. La acción no está disponible para un usuario inactivo (reactívalo primero) ni para una
cuenta sin vínculo con el proveedor de identidad (en ese caso el restablecimiento se gestiona por
completo en tu proveedor).

## Dar de baja a un usuario

Cuando alguien se va, ábrelo y elige **Dar de baja**. lazyit muestra el impacto completo de antemano —
los **activos a devolver** y el **acceso a aplicaciones a revocar** — y luego, al confirmar:

- **revoca** el acceso activo a aplicaciones de la persona,
- **libera** los activos que tiene,
- **archiva** al usuario (un borrado lógico) para que ya no se le puedan asignar activos.

**Nada se destruye.** La persona y su historial se conservan para el registro. Puedes completar una nota
de entrega e imprimir un **acta de baja** (con el nombre de la empresa y líneas de firma) para firmar en
papel en la entrega. Dar de baja es válido incluso cuando la persona no tiene nada — sigue valiendo como
constancia de su salida.

## Restaurar un usuario

Los usuarios dados de baja quedan archivados, no eliminados. Para recuperar uno, muestra los usuarios
archivados en la lista de Usuarios y elige **Restaurar**. Restaurar es solo para administradores.

> Dar de baja (y cualquier desactivación) libera los recursos que tenía una persona pero conserva todo
> el historial —quién tuvo qué activo y cuándo, y qué acceso tenía— porque lazyit está construido para
> que las personas roten mientras el registro persiste.

Consulta [Roles](/help/users-permissions-roles) para asignar niveles de acceso y
[Permisos](/help/permissions) para lo que puede hacer cada rol.

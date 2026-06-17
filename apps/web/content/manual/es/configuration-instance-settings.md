---
title: Configuración
category: configuration
subcategory: instance-settings
order: 1
---

# Configuración

**Configuración** es el área reservada a administradores para ajustar esta instancia de lazyit. Se
accede desde la navegación principal y está limitada al rol **Administrador**: los Miembros y los
Lectores no la ven. Todo lo que un operador configura sobre la instancia vive aquí o se enlaza desde
aquí.

## Qué hay en Configuración

La página de inicio de Configuración es una cuadrícula de tarjetas, cada una abre un subárea concreta:

- **Taxonomías** — gestiona las categorías que clasifican activos, aplicaciones, consumibles y
  artículos de la base de conocimiento, además de los modelos de activo que los activos referencian.
  Consulta [Taxonomías](/help/configuration-taxonomies).
- **Ubicaciones** — el registro de los lugares donde físicamente residen tus activos (oficinas,
  centros de datos, racks, almacenamiento). Es un registro de poco tráfico, por eso se ubica aquí en
  Configuración y no en la navegación principal; la tarjeta enlaza a la página completa de Ubicaciones.
- **Roles** — consulta quién tiene cada rol en el equipo. Es una vista de solo lectura; el rol de una
  persona se cambia desde la sección Usuarios, y lo que cada rol puede hacer se ajusta en
  [Permisos](/help/users-permissions-permissions).
- **Cuentas de servicio** — crea y gestiona credenciales de API no humanas para CI, scripts e
  integraciones, acotadas por permiso y revocables.
- **Integraciones y flujos** — la bandeja de tareas manuales entre aplicaciones para los flujos de
  aprovisionamiento. La automatización de cada aplicación se configura en su propia pestaña de Flujos.
- **Instancia** — revisa cómo está configurada la instancia y gestiona el esquema de etiquetas de
  activos.

## La página Instancia

La tarjeta **Instancia** abre una vista de estado de cómo está montada lazyit. La tarjeta superior es
de **solo lectura**: refleja el estado actual, no lo cambia. Muestra:

- **Configurada** — si la configuración inicial está completa (existe un administrador). Una
  instalación nueva muestra *Configuración pendiente* hasta que se crea el primer administrador.
- **Proveedor de identidad** — la postura de inicio de sesión: *Zitadel (incluido)* u *OIDC genérico
  (el tuyo propio)*.
- **Administradores** — cuántas cuentas de administrador tiene la instancia.
- **Postura de ejecución** — *Desarrollo* o *Producción*.

> Estos valores los define el entorno en el que corre la instancia, no un formulario. Los operadores
> cambian el proveedor de identidad y la postura de ejecución mediante variables de entorno al
> desplegar (consulta [Autoalojamiento](/help/deployment-operations-self-hosting)); la página
> Instancia hace que el estado resultante sea visible dentro de la aplicación. Usa **Actualizar** para
> volver a leerlo.

Debajo de la tarjeta de estado, la página Instancia aloja el editor del **esquema de etiquetas de
activos** y su herramienta de backfill — el único ajuste configurable de esta página. Consulta
[Esquema de etiquetas de activos](/help/configuration-asset-tag-scheme).

## Qué se configura en otro sitio

No todo ajuste de la instancia es un formulario en Configuración. Varios se controlan a propósito
desde el **entorno** y no desde la interfaz, porque son cuestiones de despliegue que el operador
gestiona:

- **Proveedor de identidad y postura de ejecución** — variables de entorno (visibles en solo lectura
  en la página Instancia).
- **Zona horaria de visualización** — la variable `NEXT_PUBLIC_DEFAULT_TIME_ZONE`. Consulta
  [Zona horaria y formatos](/help/configuration-time-zone-formats).
- **Conexión del motor de búsqueda y reindexación** — entorno más un script de mantenimiento. Consulta
  [Índice de búsqueda](/help/configuration-search-index).

Esta separación es deliberada: la clasificación y el acceso del día a día viven en la interfaz,
mientras que los ajustes de postura e infraestructura viven con el despliegue para que estén
versionados y sean reproducibles.

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
- **Versión** — la versión exacta que ejecuta esta instancia, fijada al construir sus imágenes. Un
  despliegue de una versión publicada muestra la etiqueta de la versión (por ejemplo, `v1.4.2`); una
  compilación hecha entre versiones muestra, con honestidad, la forma extendida `v1.4.2-3-gabc1234`
  (la versión publicada más cercana más el commit desde el que se construyó); una ejecución local de
  desarrollo muestra `dev`. Cita este valor en los reportes de errores y antes de actualizar.

> Estos valores los define el entorno en el que corre la instancia, no un formulario. Los operadores
> cambian el proveedor de identidad y la postura de ejecución mediante variables de entorno al
> desplegar (consulta [Autoalojamiento](/help/deployment-operations-self-hosting)); la página
> Instancia hace que el estado resultante sea visible dentro de la aplicación. Usa **Actualizar** para
> volver a leerlo.

## Versión y actualizaciones

La primera tarjeta de la página Instancia es **Versión y actualizaciones**. Muestra la versión que
ejecutas y, si te suscribes, si hay una versión más nueva disponible — y te da una forma *guiada* de
actualizar.

### Comprobar actualizaciones (opcional)

La comprobación de actualizaciones está **desactivada por defecto**. Activa **Comprobar actualizaciones
semanalmente** y lazyit, aproximadamente una vez por semana, hará una única consulta anónima a GitHub
para ver si existe una versión más nueva. Es **sin baliza**: nunca sale del host ninguna información
sobre tu instancia — es el mismo tipo de consulta que comprobar un espejo de software. Si la consulta
está bloqueada (un host de egreso restringido o aislado), simplemente falla en silencio y la tarjeta
vuelve a mostrar tu versión actual. "No se pudo comprobar" nunca se interpreta como "actualizado".

Cuando se ve por primera vez una versión más nueva, los administradores reciben una notificación al
respecto (y un correo, si SMTP está configurado — consulta la tarjeta SMTP de esta página). Se te avisa
**una vez por cada versión nueva**, no cada semana, para que el aviso siga siendo significativo.

**Las versiones de seguridad destacan.** Cuando una versión del intervalo es una corrección de seguridad,
la insignia de estado se vuelve roja (*N versiones por detrás — seguridad*), aparece un aviso distintivo
**Actualización de seguridad disponible** y el correo se marca como actualización de seguridad en el
asunto — para que una corrección que conviene aplicar esta noche no se pierda entre subidas de versión
rutinarias. Si una versión de la que ya te avisaron se publica *después* como corrección de seguridad,
recibes un correo más para que no se te pase; tras eso deja de insistir.

La tarjeta muestra tu **versión actual**, una insignia de estado (*Actualizado*, *N versiones por
detrás*, *Comprobación desactivada*, *No se pudo comprobar* o la variante roja de *seguridad*), la
**última versión** con un enlace a sus notas, y cuándo fue la **última comprobación**.

### Actualizar (guiado, no de un solo clic)

Actualizar lazyit es una **acción guiada del lado del host** — deliberadamente *no* un botón de un solo
clic dentro de la app. La aplicación nunca se actualiza a sí misma; una persona ejecuta la actualización
en el servidor. Es una decisión de seguridad: cualquier cosa capaz de actualizar la app en su sitio
necesitaría control con permisos de root sobre tu servidor, algo que la app está diseñada para no tener
nunca.

Cuando estás por detrás, la tarjeta muestra un único botón **Actualizar a vX.Y.Z**. Pulsarlo **no**
actualiza nada — registra la solicitud y te muestra el comando exacto para ejecutar en el host:

```
./infra/update.sh vX.Y.Z
```

Ejecuta ese comando en el servidor (por SSH). El script es cuidadoso y no destructivo. En orden:

1. **Respalda ambas bases de datos** (la de la app y la de identidad) y verifica que cada respaldo se
   pueda restaurar. **Si el respaldo falla, la actualización se aborta** — no hay forma de forzarla.
2. **Verifica la firma de la versión** y la descarga.
3. **Comprueba si hay ajustes nuevos requeridos.** Si la nueva versión necesita una variable de entorno
   que aún no tienes, **se detiene y te dice exactamente qué añadir** — nunca edita por ti tu archivo de
   secretos.
4. **Compila la nueva versión mientras la actual sigue sirviendo**, luego cambia a ella (una breve
   interrupción de ~1 minuto) y confirma que la nueva versión está sana.

Mientras una actualización se ejecuta, la tarjeta muestra la etapa real (respaldando, migrando,
compilando, reiniciando, verificando) — no una barra de progreso falsa — y se reconecta con discreción
cuando la app vuelve.

### Si una actualización falla — el punto de restauración

El respaldo previo a la actualización es un **punto de restauración**, no un deshacer mágico. Si la
actualización falla **antes** de migrar la base de datos, el script revierte automáticamente y no se
pierde nada. Si falla **después** de que corriera una migración, no hay reversión automática: volver
atrás implica **restaurar el respaldo previo**, lo que **descarta todo lo escrito desde que se tomó el
respaldo** (unos minutos). El script nunca hace esto en silencio — se detiene e imprime los comandos de
restauración exactos para que los ejecutes tú, y la versión anterior, sus imágenes y los respaldos se
conservan hasta que confirmes que la nueva versión está sana. El procedimiento completo está en el
runbook de respaldos.

## Esquema de etiquetas de activos

Debajo de estas tarjetas, la página Instancia aloja el editor del **esquema de etiquetas de activos** y
su herramienta de backfill. Consulta
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

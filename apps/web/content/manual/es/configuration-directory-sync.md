---
title: Sincronización de directorio AD / LDAP
category: configuration
subcategory: directory-sync
order: 5
---

# Sincronización de directorio AD / LDAP

lazyit puede **importar personas desde tu Active Directory local (o cualquier directorio LDAP)** para que no
tengas que cargar tu equipo en lazyit a mano. Apuntas lazyit a tu directorio en **Ajustes → Instancia →
Sincronización de directorio AD / LDAP** (solo administradores). Está **desactivada hasta que la actives**.

## Qué hace — y qué deliberadamente no hace

La sincronización de directorio es **de solo lectura y en un solo sentido**. lazyit se conecta a tu
directorio con una cuenta de servicio de solo lectura, busca en un subárbol que elijas y **crea una
"persona de directorio" sin acceso** en lazyit por cada entrada coincidente. Eso es toda la función.

- **Nunca escribe nada de vuelta** en tu directorio. lazyit solo lee.
- **No es una forma de iniciar sesión.** Una persona de directorio **no tiene contraseña ni inicio de sesión
  único** — importar a alguien no le permite entrar. Es un registro de una persona (un nombre y correo a los
  que puedes asignar activos, conceder acceso y hacer seguimiento), no una cuenta. Para dar un inicio de
  sesión real a una persona importada, usa **Aprovisionar cuenta** en su perfil, en la sección **Usuarios**.
- **No cambia cómo funcionan los permisos.** Todas las personas importadas son de nivel visor. Los grupos
  del directorio (`memberOf`) se registran solo como referencia y no otorgan nada.

Las personas de directorio son usuarios normales en lazyit, mezcladas en la lista de **Usuarios** y marcadas
con una insignia **Directorio** — el mismo tipo de persona sin acceso que crea la importación masiva.

## Configurar la conexión

El editor tiene estos campos:

- **Activar sincronización programada** — el interruptor principal de la importación **automática y
  periódica**. Mientras está desactivada, lazyit solo importa cuando pulsas **Sincronizar ahora** (ver más
  abajo).
- **Host del directorio** y **Puerto** — la dirección de tu servidor de directorio (por ejemplo
  `dc01.corp.example.com`, puerto `636`).
- **Seguridad del transporte** — cómo se protege la conexión:
  - **LDAPS** (recomendado, normalmente puerto `636`) — cifrado desde el primer byte.
  - **StartTLS** (normalmente puerto `389`) — conecta en texto plano y luego actualiza a TLS.
  - **Texto plano** (puerto `389`) — sin cifrado. La contraseña de conexión viaja en claro, así que úsalo
    solo en un segmento interno de confianza.
- **Verificar certificado TLS** — activado por defecto (seguro). Desactívalo solo si tu servidor usa un
  certificado autofirmado de confianza. No aplica a una conexión en texto plano.
- **Base de búsqueda (base DN)** — el subárbol donde lazyit busca, por ejemplo
  `OU=People,DC=corp,DC=example,DC=com`.
- **DN de conexión (bind DN)** — la cuenta de servicio de solo lectura con la que lazyit se conecta, por
  ejemplo `CN=svc-lazyit,OU=Service,DC=corp,DC=example,DC=com`. Identifica la credencial; no es el secreto
  en sí.
- **Contraseña de conexión** — la contraseña de la cuenta de servicio. Es **de solo escritura**: una vez
  guardada, lazyit solo muestra que hay una contraseña **configurada** y no la vuelve a mostrar. Deja el
  campo en blanco al editar para **conservar** la contraseña guardada; escribe un valor nuevo solo para
  cambiarla.
- **Filtro de búsqueda** — el filtro LDAP que selecciona qué entradas importar, por ejemplo
  `(&(objectClass=user)(objectCategory=person))`. Se ejecuta **literalmente** — lazyit nunca sustituye nada
  en él por usuario.
- **Margen de baja (días)** — cuántos días puede **faltar una persona en el directorio** antes de que lazyit
  la **desactive** (ver más abajo). `0` la desactiva en la primera sincronización que ya no la encuentre.
- **Mapeo de atributos** — qué atributo del directorio rellena cada campo de lazyit. Escribe el nombre del
  atributo del directorio junto a cada campo de lazyit (los nombres típicos de Active Directory son
  `givenName`, `sn`, `mail`, `sAMAccountName`). Deja un campo en blanco para omitirlo.

> La contraseña de conexión se guarda **cifrada en reposo**. Guardar una contraseña requiere que la clave de
> servidor `DIRECTORY_SECRET_KEY` esté configurada; si no lo está, lazyit guarda el resto de la
> configuración y te pide configurar la clave primero. Consulta la configuración de entorno de tu
> despliegue.

## Ejecutar una sincronización y leer el resultado

Usa **Sincronizar ahora** para importar de inmediato con la configuración **guardada** — así que **guarda
primero**, luego sincroniza. Sincronizar ahora funciona incluso con la sincronización programada
desactivada, así que sirve también como **prueba de conexión**: si la conexión o la búsqueda fallan, lazyit
muestra un error breve y sin datos sensibles (por ejemplo "bind failed" o "host unreachable").

Después de cada ejecución — manual o programada — el panel muestra el **estado y la hora de la última
ejecución** y un recuento de lo ocurrido:

- **Creadas** — nuevas personas de directorio añadidas.
- **Actualizadas** — personas existentes cuyos campos mapeados se refrescaron.
- **Dadas de baja** — personas **desactivadas** porque habían faltado en el directorio más allá del margen.
  Es una **desactivación suave** (pasan a inactivas, conservando su historial), nunca un borrado definitivo.
- **Omitidas** — entradas que quedaron sin tocar (por ejemplo una entrada que no se puede identificar, o una
  cuyo correo coincide con una cuenta con inicio de sesión real).

## Revisar las personas importadas

Debajo del editor, **Personas del directorio para revisar** muestra una vista previa de las importadas más
recientemente. Cada una enlaza a su perfil, donde puedes editarla, **aprovisionar un inicio de sesión** o
darla de baja. Usa **Ver todas en Usuarios** para abrir la lista completa y con búsqueda filtrada a las
personas de directorio.

## Actualizar una instancia existente

La sincronización de directorio está **desactivada por defecto** y no añade nada hasta que un administrador
la configure, así que actualizar una instancia existente de lazyit no cambia nada por sí solo. Actívala solo
después de haber configurado la clave de servidor `DIRECTORY_SECRET_KEY` y completado la conexión.

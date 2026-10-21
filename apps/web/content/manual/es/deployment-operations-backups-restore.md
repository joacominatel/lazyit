---
title: Copias de seguridad y restauración
order: 3
category: deployment-operations
subcategory: backups-restore
---

# Copias de seguridad y restauración

Cómo respaldar todo lo que una instancia de lazyit necesita para sobrevivir a la pérdida de disco, y
cómo restaurarlo en el orden correcto. Una restauración que funcione y esté **probada** es obligatoria
antes de confiar datos reales a una instancia.

> El error más habitual en recuperación ante desastres es respaldar solo la base de datos de la
> aplicación. Las claves que hacen legibles sus datos viven en el archivo de entorno, que ningún volcado
> contiene. Si falta cualquiera de las dos cosas, el peor caso es: «restauré la copia y los datos no se
> pueden leer».

## Qué respaldar

| Elemento | Dónde vive | ¿Respaldar? |
| --- | --- | --- |
| **Archivo de entorno** (`infra/env/.env.prod`) | un archivo en el servidor | **Sí — fuera del servidor, cifrado.** Irremplazable: guarda la contraseña de la base de datos y las claves de cifrado. |
| **Base de datos de la aplicación** | el servicio `db` | **Sí.** Tus datos — y, con cuentas locales, las credenciales de inicio de sesión de todos. |
| **Archivos subidos** | el volumen de adjuntos | **Sí.** Documentos de activos y compras (facturas, órdenes, remitos) e imágenes de la base de conocimiento. La base de datos solo los registra; los archivos en sí están aquí. |
| Índice de búsqueda | el servicio `meilisearch` | No — reconstruible reindexando desde la base de datos. |
| Certificados TLS | el servicio `caddy` | No — se reemiten automáticamente. |

El archivo de entorno es tu responsabilidad copiarlo fuera del servidor. La base de datos y los
archivos subidos se respaldan automáticamente con el contenedor de copias (más abajo), como un par:
consérvalos y restáuralos juntos.

## La clave que no puedes perder

La **clave de secretos de flujos de trabajo** del archivo de entorno es **irrotable e irremplazable**.
No está dentro de ningún volcado de base de datos: descifra las credenciales que guarda el motor de
flujos de aplicaciones. Restaura la base de datos sin la clave correspondiente y esas credenciales de
conector quedan indescifrables.

Nunca generes un valor nuevo para ella en una restauración. Guarda una copia sellada fuera del servidor
y respáldala siempre junto con el volcado de base de datos *correspondiente*.

## El Gestor de Secretos es una excepción deliberada

La regla de recuperación «un volcado de base de datos más la clave de entorno correspondiente vuelve a
hacer legibles los datos» vale para todo **excepto** para el Gestor de Secretos, que está cifrado de
**extremo a extremo (conocimiento cero)**. Sus claves de descifrado las **tienen los usuarios**, nunca
el servidor y nunca el archivo de entorno.

Qué significa esto para la recuperación:

- Una restauración perfecta de base de datos y entorno **no** hace legibles por sí sola los valores de
  las bóvedas. Las filas restauradas solo guardan texto cifrado. Los valores vuelven cuando un miembro
  que sobrevive inicia sesión, o cuando un miembro que sobrevive canjea **su propia** clave de
  recuperación.
- La **clave de recuperación es el artefacto personal del usuario, mostrado una sola vez**: es
  responsabilidad del usuario guardarla fuera del servidor. El operador no puede respaldarla por él.
  Haz que «guarda tu clave de recuperación a buen recaudo» forme parte de la incorporación.
- Una bóveda cuyo único miembro pierde **tanto** su inicio de sesión **como** su clave de recuperación
  es una **pérdida permanente por diseño**: ninguna restauración de base de datos ni ningún
  administrador pueden recuperar el texto en claro. Mantén las bóvedas sensibles con varios miembros
  para que un compañero pueda restaurar el acceso. Consulta [Gestor de Secretos](/help/secret-manager).

## Copias de seguridad automáticas (el contenedor de copias)

Un servicio de **copia** se ejecuta según una programación. En cada ejecución vuelca la base de datos de
la aplicación, luego archiva los archivos subidos, y escribe ambos en `./backups` con la misma marca de
tiempo — `app-<hora>.dump` y `attachments-<hora>.tar.gz` —; después elimina las copias más antiguas que
su ventana de retención (14 días para los volcados de la base de datos, 7 para los archivos de adjuntos
por defecto). Tiene un enganche opcional de copia externa y otro opcional de alerta ante fallos.

Arranca con la pila de producción: el levantamiento estándar (`./infra/start.sh`, `./infra/update.sh`)
ya lo ejecuta, diga lo que diga la pregunta sí/no del instalador sobre copias. Compruébalo con
`docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod ps backup`. Para
levantarlo por separado:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --env-file infra/env/.env.prod \
  --profile prod --profile backup up -d backup
```

Ajústalo en el archivo de entorno (valores por defecto mostrados):

```sh
BACKUP_CRON="30 2 * * *"     # cuándo ejecutar (sintaxis de crontab) — por defecto, diario a las 02:30
BACKUP_RETENTION_DAYS=14     # elimina volcados de la base de datos con más de estos días
BACKUP_ATTACHMENTS=true      # archiva los archivos subidos en cada ejecución; false lo desactiva
BACKUP_ATTACHMENTS_RETENTION_DAYS=7   # elimina archivos de adjuntos con más de estos días
BACKUP_MIN_FREE_MB=1024      # omite el archivo de adjuntos si dejaría menos disco libre que esto
BACKUP_OFFSITE_CMD=          # copia externa opcional, se ejecuta por cada archivo con su ruta como "$1"
BACKUP_ON_FAILURE_CMD=       # alerta opcional, se ejecuta con el motivo como "$1" cuando falla una ejecución
```

Por ejemplo, `BACKUP_OFFSITE_CMD='rclone copy "$1" offsite:lazyit/'` envía los dos archivos de cada
ejecución a un remoto de rclone. El contenedor **no** respalda el archivo de entorno —cópialo fuera del
servidor tú mismo— y no cifra nada: cifra la copia externa. No necesitas añadir ninguna de estas
variables al archivo de entorno: una instancia actualizada en el lugar usa los valores por defecto
mostrados.

Define `BACKUP_ATTACHMENTS=false` solo si respaldas los archivos subidos de otra forma (por ejemplo, con
instantáneas del disco del servidor): los volcados de la base de datos siguen, pero los archivos pasan a
ser tu responsabilidad. Los archivos de adjuntos que ya estén en `./backups` siguen caducando según su
retención.

**Planifica el espacio en disco.** El archivo de adjuntos es una copia completa en cada ejecución, del
tamaño aproximado de todos los archivos subidos; por eso conserva menos días que los volcados de la base
de datos. Con los valores por defecto son unas 8 copias: 300 MB de adjuntos ocupan unos 2,4 GB en
`./backups`; 1 GB, unos 8 GB; 5 GB, unos 40 GB. Una restauración necesita el volcado y el archivo de
adjuntos de la misma ejecución, así que solo los últimos 7 días se pueden restaurar con sus archivos. Si
el disco está demasiado lleno, la ejecución omite el archivo de adjuntos e informa un fallo en lugar de
llenar el disco que usa la base de datos; el volcado de la base de datos se escribe igual. Reduce
`BACKUP_ATTACHMENTS_RETENTION_DAYS`, dale a `./backups` un disco más grande, o copia cada ejecución fuera
del servidor y conserva menos días en local.

Una ejecución fallida nunca pasa en silencio: el registro muestra
`[lazyit-backup] FAILED run <hora>: <motivo>`, y tu enganche de alerta se dispara si lo definiste.
Compruébalo con
`docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod logs backup | grep lazyit-backup`.

## Copia manual

La base de datos permanece en la red interna, así que el volcado se ejecuta dentro de la red de
compose. El formato personalizado (`-Fc`) está comprimido y admite restauración selectiva. Primero la
base de datos, luego los archivos:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
$DC exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "app-$(date +%Y%m%d-%H%M%S).dump"
$DC run --rm --no-deps -T backup \
  sh -c 'tar -czf - -C /attachments --exclude ./tmp .' > "attachments-$(date +%Y%m%d-%H%M%S).tar.gz"
```

Con el contenedor de copias en marcha, `$DC exec -T backup lazyit-backup` toma en su lugar un par
completo y verificado ahora mismo en `./backups`.

Copia el volcado, el archivo de adjuntos **y** `infra/env/.env.prod` fuera del servidor, a una ubicación
segura y con control de acceso.

## Restauración

> Restaurar sobrescribe los datos actuales. Haz una copia fresca primero, y nunca pruebes una
> restauración contra una base de datos que no puedas permitirte perder.

Para una recuperación completa sobre un servidor reconstruido, restaura en este orden:

1. **Pon primero el archivo de entorno.** Debe contener las **mismas claves** que cuando se volcó la
   base de datos. `chmod 600 infra/env/.env.prod`.
2. **Restaura la base de datos de la aplicación** desde su volcado. Levanta solo el servicio `db` para
   esto.
3. **Restaura los archivos subidos** desde el archivo **de la misma ejecución** (misma marca de tiempo),
   antes de que arranque la API. Pon el archivo en `./backups` y luego:

   ```sh
   DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
   $DC stop api
   $DC run --rm --no-deps -T -v lazyit-prod_attachments_data:/restore backup \
     sh -c 'find /restore -mindepth 1 -delete && tar -xzf /backups/attachments-20260530-120000.tar.gz -C /restore --numeric-owner'
   ```

   Esto vacía el volumen de adjuntos y desempaqueta el archivo en él, conservando el propietario y las
   fechas de cada archivo.
4. **Levanta la pila.**
5. **Reindexa la búsqueda** — el índice es reconstruible:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

> **Mantén la base de datos y los archivos en sintonía.** lazyit limpia periódicamente los archivos
> guardados a los que ningún registro apunta. Arranca la API contra una base de datos que no corresponde
> a los archivos restaurados —una vacía, o un volcado mucho más antiguo— y esa limpieza borra los
> archivos restaurados. Restaura ambos de la misma ejecución, primero la base de datos, antes de que
> arranque la API.

> **Nunca restablezcas la base de datos con `down -v`.** Ese comando elimina **todos** los volúmenes con
> nombre — también los adjuntos subidos, no solo la base de datos. Para restablecer solo la base de
> datos, elimina únicamente su volumen (`docker volume rm lazyit-prod_db_data`), levanta ese servicio en
> limpio y luego carga el volcado.

Verifica la restauración de principio a fin iniciando sesión a través de la web y comprobando que tus
registros están ahí, y abre un documento de un activo o de una compra. Si usas el motor de flujos de aplicaciones, ejecuta también **Probar conexión** en
una conexión: demuestra que la clave de secretos de flujos de trabajo coincide con la base de datos
restaurada.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Actualizaciones](/help/deployment-operations-upgrades)
- [Gestor de Secretos](/help/secret-manager)

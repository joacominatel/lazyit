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
| Índice de búsqueda | el servicio `meilisearch` | No — reconstruible reindexando desde la base de datos. |
| Certificados TLS | el servicio `caddy` | No — se reemiten automáticamente. |

El archivo de entorno es tu responsabilidad copiarlo fuera del servidor. La base de datos puede
volcarse automáticamente con el contenedor de copias opcional (más abajo).

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

## Copias de seguridad automáticas (contenedor opcional)

Un servicio de **copia** opcional vuelca la base de datos de la aplicación según una programación a una
carpeta del servidor, con retención, y un enganche opcional de copia externa. Está desactivado por
defecto. Levántalo junto a la pila en marcha:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --env-file infra/env/.env.prod \
  --profile prod --profile backup up -d backup
```

Ajústalo en el archivo de entorno (valores por defecto mostrados):

```sh
BACKUP_CRON="30 2 * * *"     # cuándo ejecutar (sintaxis de crontab) — por defecto, diario a las 02:30
BACKUP_RETENTION_DAYS=14     # elimina volcados con más de estos días
BACKUP_OFFSITE_CMD=          # enganche de copia externa opcional — apagado salvo que lo definas
```

El contenedor escribe volcados con marca de tiempo de la base de datos de la aplicación en `./backups`.
**No** respalda el archivo de entorno: cópialo fuera del servidor tú mismo.

## Copia manual

La base de datos permanece en la red interna, así que el volcado se ejecuta dentro de la red de
compose. El formato personalizado (`-Fc`) está comprimido y admite restauración selectiva:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod"
$DC exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "app-$(date +%Y%m%d-%H%M%S).dump"
```

Copia el volcado **y** `infra/env/.env.prod` fuera del servidor, a una ubicación segura y con
control de acceso.

## Restauración

> Restaurar sobrescribe los datos actuales. Haz una copia fresca primero, y nunca pruebes una
> restauración contra una base de datos que no puedas permitirte perder.

Para una recuperación completa sobre un servidor reconstruido, restaura en este orden:

1. **Pon primero el archivo de entorno.** Debe contener las **mismas claves** que cuando se volcó la
   base de datos. `chmod 600 infra/env/.env.prod`.
2. **Restaura la base de datos de la aplicación** desde su volcado.
3. **Levanta la pila.**
4. **Reindexa la búsqueda** — el índice es reconstruible:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

> **Nunca restablezcas la base de datos con `down -v`.** Ese comando elimina **todos** los volúmenes con
> nombre — también los adjuntos subidos, no solo la base de datos. Para restablecer solo la base de
> datos, elimina únicamente su volumen (`docker volume rm lazyit-prod_db_data`), levanta ese servicio en
> limpio y luego carga el volcado.

Verifica la restauración de principio a fin iniciando sesión a través de la web y comprobando que tus
registros están ahí. Si usas el motor de flujos de aplicaciones, ejecuta también **Probar conexión** en
una conexión: demuestra que la clave de secretos de flujos de trabajo coincide con la base de datos
restaurada.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Actualizaciones](/help/deployment-operations-upgrades)
- [Gestor de Secretos](/help/secret-manager)

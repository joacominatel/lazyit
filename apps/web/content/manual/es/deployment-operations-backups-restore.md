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
> aplicación. La pila ejecuta **dos** bases de datos, y las claves que las desbloquean viven en el
> archivo de entorno. Si falta cualquiera de esas tres cosas, el peor caso es: «restauré la copia y
> nadie puede iniciar sesión».

## Qué respaldar

| Elemento | Dónde vive | ¿Respaldar? |
| --- | --- | --- |
| **Archivo de entorno** (`infra/env/.env.prod`) | un archivo en el servidor | **Sí — fuera del servidor, cifrado.** Irremplazable: guarda la contraseña de la base de datos y las claves maestras. |
| **Base de datos de la aplicación** | el servicio `db` | **Sí.** Tus datos. |
| **Base de datos del proveedor de identidad** | el servicio `zitadel_db` | **Sí** — y debes conservar con ella la clave maestra *correspondiente*. |
| Índice de búsqueda | el servicio `meilisearch` | No — reconstruible reindexando desde las bases de datos. |
| Certificados TLS | el servicio `caddy` | No — se reemiten automáticamente. |

El archivo de entorno es tu responsabilidad copiarlo fuera del servidor. Las dos bases de datos pueden
volcarse automáticamente con el contenedor de copias opcional (más abajo).

## Las claves que no puedes perder

En el archivo de entorno viven dos claves maestras **irrotables e irremplazables**. No están dentro de
ningún volcado de base de datos: son las claves que hacen legibles esos volcados:

- La **clave maestra del proveedor de identidad** descifra el almacén del proveedor de identidad. Si la
  pierdes, ni un volcado perfecto de la base de datos puede iniciar la sesión de nadie.
- La **clave de secretos de flujos de trabajo** descifra las credenciales que guarda el motor de flujos
  de aplicaciones. Restaura la base de datos sin la clave correspondiente y esas credenciales de
  conector quedan indescifrables.

Nunca generes un valor nuevo para ninguna de estas claves en una restauración. Guarda una copia sellada
fuera del servidor y respáldalas siempre junto con el volcado de base de datos *correspondiente*.

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

Un servicio de **copia** opcional vuelca **ambas** bases de datos según una programación a una carpeta
del servidor, con retención, y un enganche opcional de copia externa. Está desactivado por defecto.
Levántalo junto a la pila en marcha:

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

El contenedor escribe volcados con marca de tiempo de ambas bases de datos en `./backups`. **No**
respalda el archivo de entorno: cópialo fuera del servidor tú mismo.

## Copia manual

Ambas bases de datos permanecen en la red interna, así que los volcados se ejecutan dentro de la red de
compose. El formato personalizado (`-Fc`) está comprimido y admite restauración selectiva:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod"
# Base de datos de la aplicación:
$DC exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "app-$(date +%Y%m%d-%H%M%S).dump"
# Base de datos del proveedor de identidad (sus propias credenciales):
$DC exec -T zitadel_db sh -c 'pg_dump -U "$ZITADEL_DB_USER" -d "$ZITADEL_DB_NAME" -Fc' > "zitadel-$(date +%Y%m%d-%H%M%S).dump"
```

Copia ambos volcados **y** `infra/env/.env.prod` fuera del servidor, a una ubicación segura y con
control de acceso.

## Restauración

> Restaurar sobrescribe los datos actuales. Haz una copia fresca primero, y nunca pruebes una
> restauración contra una base de datos que no puedas permitirte perder.

Para una recuperación completa sobre un servidor reconstruido, restaura en este orden:

1. **Pon primero el archivo de entorno.** Debe contener las **mismas claves maestras** que cuando se
   volcaron las bases de datos. `chmod 600 infra/env/.env.prod`.
2. **Restaura la base de datos del proveedor de identidad** desde su volcado.
3. **Restaura la base de datos de la aplicación** desde su volcado.
4. **Levanta la pila.**
5. **Reindexa la búsqueda** — el índice es reconstruible:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

> **Nunca restablezcas una sola base de datos con `down -v`.** Ese comando elimina **todos** los
> volúmenes con nombre, incluido el proveedor de identidad completo (todas las cuentas y el cliente
> OIDC). Para restablecer solo una base de datos, elimina únicamente su volumen (para la base de datos
> de la aplicación es `docker volume rm lazyit-prod_db_data`), levanta ese servicio en limpio y luego
> carga el volcado.

Restaurar cada base de datos tiene la misma forma: cargar el volcado, con las credenciales correctas.
Verifica la restauración de principio a fin iniciando sesión a través de la web: un inicio de sesión
correcto es la prueba real de que ambas bases de datos y la clave maestra encajan.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Actualizaciones](/help/deployment-operations-upgrades)
- [Gestor de Secretos](/help/secret-manager)

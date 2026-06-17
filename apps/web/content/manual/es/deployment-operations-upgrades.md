---
title: Actualizaciones
order: 7
category: deployment-operations
subcategory: upgrades
---

# Actualizaciones

Cómo llevar una instancia a una versión más nueva de lazyit. Las actualizaciones son rutinarias —
descarga el código nuevo, reconstruye las imágenes, levanta la pila — pero **respalda siempre primero**,
porque las migraciones de base de datos solo avanzan.

## Antes de actualizar

> **Respalda primero ambas bases de datos y el archivo de entorno.** Las migraciones de base de datos
> solo avanzan: no hay reversión automática. Tu red de seguridad es la copia previa a la actualización.
> Consulta [Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

## La actualización

Desde la raíz del repositorio:

```sh
git pull          # o despliega un nuevo artefacto compilado / imagen
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
```

La reconstrucción levanta las imágenes nuevas, y el trabajo puntual de **migración** se vuelve a ejecutar
automáticamente antes de que arranque la API — aplicando cualquier migración nueva (sin efecto si no hay
nada pendiente). No ejecutas las migraciones a mano.

## Nuevos ajustes obligatorios tras una descarga

Una versión que añade una función puede introducir un **nuevo valor de entorno obligatorio**. El arranque
guiado solo escribe valores nuevos en una generación desde cero — nunca edita un archivo de entorno
existente — así que tras descargar una versión que lo necesite, añádelo a mano y recrea el servicio
afectado. Dos ejemplos que ya han llegado:

- La **URL del intermediario de trabajos en segundo plano** (`REDIS_URL`), obligatoria desde que llegaron
  los trabajadores en segundo plano. Si falta, la importación de documentos en segundo plano falla.

  ```sh
  grep -q '^REDIS_URL=' infra/env/.env.prod || echo 'REDIS_URL=redis://valkey:6379' >> infra/env/.env.prod
  docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
    --env-file infra/env/.env.prod up -d api
  ```

- La **clave de secretos de flujos de trabajo** (`WORKFLOW_SECRET_KEY`), obligatoria antes de activar el
  motor de flujos de aplicaciones. La API falla de forma ruidosa al arrancar si el motor está activado y
  la clave falta o tiene la longitud equivocada.

  ```sh
  grep -q '^WORKFLOW_SECRET_KEY=' infra/env/.env.prod \
    || echo "WORKFLOW_SECRET_KEY=$(openssl rand -hex 32)" >> infra/env/.env.prod
  docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
    --env-file infra/env/.env.prod up -d api
  ```

> La clave de secretos de flujos de trabajo es una clave **irrotable**, como la clave maestra del
> proveedor de identidad: descifra las credenciales de conector guardadas. Respáldala fuera del servidor
> y **nunca** generes una nueva en una restauración, o esas credenciales quedan indescifrables. Consulta
> [Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

Las notas de la versión señalan cualquier valor obligatorio nuevo. En caso de duda, compara tu archivo de
entorno con el ejemplo incluido (`infra/env/.env.prod.example`) buscando entradas recién añadidas.

## Revertir

No hay reversión automática. Para volver a una versión anterior, restaura la **copia de la base de datos
previa a la actualización** y vuelve a desplegar la imagen anterior. Por eso es obligatoria la copia
previa a la actualización.

## Versiones de los componentes incluidos

Las imágenes incluidas (base de datos, proveedor de identidad, búsqueda, intermediario, proxy) están
fijadas a versiones concretas para despliegues reproducibles. Solo cambian con una subida deliberada.
Antes de subir en particular el proveedor de identidad, respalda su base de datos **y** conserva la clave
maestra correspondiente, ya que sus datos están ligados a esa clave.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Copias de seguridad y restauración](/help/deployment-operations-backups-restore)
- [Resolución de problemas](/help/deployment-operations-troubleshooting)
- [Servicios](/help/deployment-operations-services)

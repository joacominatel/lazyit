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

> **Respalda primero la base de datos y el archivo de entorno.** Las migraciones de base de datos
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

## Política de soporte

Solo se da soporte a la **última versión** — mantente al día. **No** hace falta instalar las versiones una
por una: saltar de golpe varias versiones (por ejemplo **1.2 → 1.9**) en una sola actualización es seguro,
porque el trabajo puntual de **migración** aplica **en orden** todas las migraciones pendientes. La **única
excepción** es una versión **mayor** dentro del rango. Una versión mayor siempre incluye una sección
**⚠️ Acciones de actualización** en sus notas de versión que describe un paso manual que debes realizar (un
nuevo ajuste obligatorio, un cambio de topología). Así que salta con libertad entre versiones de parche y
menores, pero **detente y lee las Acciones de actualización de cada versión mayor que cruces**. La versión
en ejecución se muestra en **Configuración → General y versión**.

### Funciones obsoletas

Cuando una función, ajuste, endpoint o formato de importación/exportación va a retirarse, primero se marca
como **obsoleto en una versión menor** — las notas de versión dicen *"obsoleto, se eliminará en X.0"* — y
sigue funcionando hasta entonces. Solo **se elimina en la siguiente versión mayor**, y se detalla en las
**⚠️ Acciones de actualización** de esa mayor (que ya lees antes de actualizar). Así, una actualización menor
nunca elimina algo de lo que dependes; vigila las notas de versión para detectar obsolescencias y planifica
el cambio antes de la siguiente mayor.

#### Retiro de la API de lista de nodos de infraestructura en v2.0

`GET /infra/nodes` está obsoleto y se eliminará en **v2.0**. Durante la línea de versiones v1 sigue
disponible únicamente como respuesta legacy de arreglo plano para integraciones externas. Migrá las
consultas de lista, búsqueda y resolución por ids exactos a `GET /infra/nodes/page`, que devuelve
`{ items, total, limit, offset }`. El lienzo de topología usa un contrato distinto y debe seguir
consultando `GET /infra/graph/nodes`; no reemplaces el mapa por la lista paginada.

#### Retiro del proveedor de identidad incluido

lazyit ya no incluye un proveedor de identidad propio: las personas inician sesión con cuentas locales o
a través de tu propio proveedor OIDC (consulta
[Proveedor de identidad](/help/deployment-operations-identity-provider)). Las instalaciones que ya usan
cualquiera de las dos no se ven afectadas. Si `./infra/start.sh` o la API se niegan a arrancar porque
encontraron restos del antiguo proveedor incluido, no se cambió nada — ni se escribió ningún archivo ni
se eliminó ningún volumen. Sigue la guía de migración del repositorio,
`docs/05-runbooks/migrate-off-bundled-zitadel.md`, o quédate en la versión anterior hasta que puedas.

## Nuevos ajustes obligatorios tras una descarga

Una versión que añade una función puede introducir un **nuevo valor de entorno**. Algunos los puede
añadir el script de arranque por ti (abajo); cualquier otro lo añades a mano y luego recreas el servicio
afectado.

### Claves que el script de arranque añade por ti

Si actualizas con `git pull` seguido de `./infra/start.sh`, el script detecta tu instalación existente
y, antes de levantar el stack, **añade cualquier clave que falte y sea segura de generar** — hoy la
clave de la contraseña del correo (`SMTP_SECRET_KEY`), la clave de almacenamiento de la clave del
proveedor de IA (`AI_SECRET_KEY`) y la clave de la contraseña de conexión del directorio
(`DIRECTORY_SECRET_KEY`). Cada una solo protege un secreto que lazyit se niega a guardar
mientras la clave falta, así que una nueva no puede dejarte sin acceso a nada. Funciona tanto si inicias
sesión con cuentas integradas como con un proveedor de identidad.

- Primero **hace una copia** de tu archivo de entorno, en `infra/env/.env.prod.bak-<fecha y hora>`. Esa
  copia contiene tus secretos: mantenla privada y bórrala cuando estés conforme.
- **Solo añade al final**, bajo un comentario con fecha. Tus líneas existentes nunca cambian y una clave
  que ya tienes nunca se reemplaza.
- Muestra los **nombres** de las claves que añadió, nunca sus valores. Volver a ejecutarlo no añade nada.
- `./infra/start.sh --dry-run` muestra lo que añadiría sin escribir nada.

Después de que añada una clave, respalda fuera del servidor el archivo de entorno actualizado. Las
claves que protegen datos que ya tienes — la clave de secretos de flujos de trabajo, los secretos de
inicio de sesión, las contraseñas de la base de datos — **nunca** se generan por ti: si falta una, el
script la nombra y la añades a mano. El script de actualización (`./infra/update.sh`) tampoco edita el
archivo; se detiene ante una clave que falta y te dice cuál.

### Claves que añades a mano

Dos ejemplos que ya han llegado:

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

> La clave de secretos de flujos de trabajo es una clave **irrotable**: descifra las credenciales de
> conector guardadas. Respáldala fuera del servidor y **nunca** generes una nueva en una restauración, o
> esas credenciales quedan indescifrables. Consulta
> [Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

Las notas de la versión señalan cualquier valor obligatorio nuevo. En caso de duda, compara tu archivo de
entorno con el ejemplo incluido (`infra/env/.env.prod.example`) buscando entradas recién añadidas.

## Revertir

No hay reversión automática. Para volver a una versión anterior, restaura la **copia de la base de datos
previa a la actualización** y vuelve a desplegar la imagen anterior. Por eso es obligatoria la copia
previa a la actualización.

## Versiones de los componentes incluidos

Las imágenes incluidas (base de datos, búsqueda, intermediario, proxy) están fijadas a versiones
concretas para despliegues reproducibles. Solo cambian con una subida deliberada.

El **motor de búsqueda** es la excepción que no necesita preparación. Sus datos solo se abren con la
versión exacta del motor que los escribió, así que cada actualización del motor de búsqueda arranca con
un volumen de datos **nuevo** y lazyit reconstruye el índice de búsqueda a partir de tu base de datos
automáticamente al arrancar. No hay nada que ejecutar: espera que los resultados de búsqueda estén
**incompletos durante unos minutos** tras esa actualización, y luego completos. Todo lo demás — el
inicio de sesión, los registros, la comprobación de salud que espera el script de actualización — no se
ve afectado. El volumen de búsqueda anterior se conserva (una vuelta atrás a la versión anterior lo
usa) y el script de arranque imprime el comando exacto para eliminarlo cuando ya no lo necesites, por
ejemplo:

```
docker volume rm lazyit-prod_meili_data
```

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Copias de seguridad y restauración](/help/deployment-operations-backups-restore)
- [Resolución de problemas](/help/deployment-operations-troubleshooting)
- [Servicios](/help/deployment-operations-services)

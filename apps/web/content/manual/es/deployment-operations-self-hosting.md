---
title: Autoalojamiento
order: 1
category: deployment-operations
subcategory: self-hosting
---

# Autoalojamiento

lazyit es **autoalojado y mono-organización**: una instancia sirve a una sola organización y se ejecuta
como un conjunto de contenedores en **un único servidor con Docker Compose**. No hay SaaS ni modo
multiinquilino: toda la pila vive dentro de tu empresa. Esta página es el punto de partida del operador
para levantar una instancia real.

> Esta es la vista del *operador*. Para la configuración inicial dentro de la app (crear el primer
> administrador, elegir cómo inicia sesión la gente), consulta [Primeros pasos](/help/getting-started).

## Qué necesitas

- Un servidor Linux con **Docker** y **Docker Compose**.
- El repositorio (o un artefacto compilado) en ese servidor.
- Para un dominio público con HTTPS de confianza: un **registro DNS** (A/AAAA) que apunte tu dominio al
  servidor, accesible en los **puertos 80 y 443**. En una red privada puedes mantener la autoridad de
  certificación interna de Caddy y prescindir del DNS público.
- Una **ubicación de copias de seguridad** fuera del servidor — consulta
  [Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

Un equipo pequeño (hasta ~50 activos) funciona con holgura en **2 vCPU / 4 GB de RAM / 20 GB de disco**.
La pila ejecuta ocho contenedores de larga duración más un trabajo de migración puntual; haz crecer el
servidor con tus datos.

## La vía recomendada: el arranque guiado

El primer despliegue más rápido y seguro es el script de arranque incluido. Desde la raíz del
repositorio:

```sh
./infra/start.sh
```

Comprueba los requisitos previos, hace unas seis preguntas (tu dominio, opción de TLS, puertos,
proveedor de identidad, base de datos), luego **genera el archivo de entorno con secretos aleatorios
robustos**, levanta toda la pila y te dirige al asistente de configuración dentro de la app. Es
**idempotente y no destructivo**: volver a ejecutarlo sobre una instalación existente solo levanta la
pila; nunca regenera las claves maestras irrotables y no tiene vía de desmontaje.

Opciones útiles:

```sh
./infra/start.sh --yes       # valores por defecto de localhost, sin interacción (prueba rápida)
./infra/start.sh --dry-run   # ejecuta todas las comprobaciones y preguntas, sin escribir ni arrancar nada
./infra/start.sh --help
```

Al terminar imprime tu URL y el único paso siguiente: abre **`https://<tu-servidor>/setup`** para crear
el primer administrador. El script nunca crea un usuario: eso es tarea del asistente de configuración.

> Haz una copia del archivo de entorno generado (`infra/env/.env.prod`) fuera del servidor y cifrada.
> Contiene las claves maestras; si lo pierdes, una copia restaurada queda ilegible. Consulta
> [Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

## La vía manual

Si prefieres control total, haz a mano exactamente lo que el script automatiza. Desde la raíz del
repositorio:

```sh
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod          # solo el propietario — este archivo guarda todos los secretos
# edita infra/env/.env.prod: sustituye cada valor CHANGE_ME
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
```

El `chmod 600` **no es opcional**: el archivo guarda la contraseña de la base de datos, la clave maestra
del proveedor de identidad, el secreto de sesión y más. Los permisos por defecto son legibles por todo
el mundo.

## Cómo es un despliegue

- Un único `compose.yaml` canónico en la raíz del repositorio define todos los servicios. La pila
  completa en contenedores se ejecuta tras el **perfil `prod`**, por lo que los comandos de producción
  siempre pasan `--profile prod` y apuntan a `infra/env/.env.prod`.
- La opción `--env-file` es **obligatoria** en producción: el archivo de compose resuelve los valores
  `${VAR}` a partir de él al analizarlo.
- Un trabajo puntual de **migración** aplica las migraciones de base de datos y la semilla antes de que
  arranque la API, de modo que el esquema siempre queda sincronizado tras un `up`.
- Solo el proxy inverso **Caddy** publica puertos. Las bases de datos, la API y la web permanecen en una
  red interna de Docker y nunca son accesibles desde el servidor.

Tras el primer despliegue, llena el índice de búsqueda una vez (la imagen de tiempo de ejecución de la
API no incluye Bun, así que esto se ejecuta mediante la imagen de migración):

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

## Niveles de despliegue

| Nivel | Qué se ejecuta | Para qué |
| --- | --- | --- |
| **Desarrollo** | servicios de apoyo en contenedores + las apps de forma nativa | desarrollo diario |
| **Tipo producción local** | toda la pila en contenedores, HTTPS local, puertos altos (8080/8443) | validar un despliegue con forma de producción en tu máquina |
| **Autoalojado** | la misma pila en un dominio real, Let's Encrypt, secretos reales, copias de seguridad | tu instancia en vivo |

## Qué sigue

- [Servicios](/help/deployment-operations-services) — qué hace cada contenedor.
- [Proveedor de identidad](/help/deployment-operations-identity-provider) — inicio de sesión incluido frente al propio.
- [Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls) — Caddy y certificados.
- [Copias de seguridad y restauración](/help/deployment-operations-backups-restore) — qué guardar y cómo recuperar.
- [Resolución de problemas](/help/deployment-operations-troubleshooting) — cuando un contenedor no levanta.
- [Actualizaciones](/help/deployment-operations-upgrades) — actualizar la instancia de forma segura.

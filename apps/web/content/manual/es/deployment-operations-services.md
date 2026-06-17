---
title: Servicios
order: 2
category: deployment-operations
subcategory: services
---

# Servicios

Una instancia de lazyit es un pequeño conjunto de contenedores en un servidor. Esta página explica qué
hace cada uno, para que sepas qué registros leer y qué es seguro reiniciar. El proxy inverso es el
**único** servicio que publica puertos al servidor; todo lo demás vive en una red interna de Docker.

## Los contenedores

| Servicio | Función | Notas |
| --- | --- | --- |
| **caddy** | Proxy inverso + HTTPS automático | El único servicio público. Enruta `/` a la web y `/api/*` a la API. |
| **web** | La aplicación web (Next.js) | Sirve la interfaz; gestiona el inicio de sesión en el servidor. |
| **api** | La API (NestJS) | Toda la lógica de negocio. También ejecuta los trabajos en segundo plano. |
| **db** | PostgreSQL — la base de datos de la aplicación | El sistema de registro. Guarda todos tus datos. |
| **migrate** | Trabajo puntual de migración + semilla | Se ejecuta una vez por despliegue y termina. Aplica las migraciones antes de que arranque la API. |
| **valkey** | Intermediario de trabajos en segundo plano | Respalda los trabajos asíncronos (p. ej. la importación de documentos, el motor de flujos). |
| **meilisearch** | Motor de búsqueda | Da soporte a la búsqueda transversal. Reconstruible desde la base de datos. |
| **zitadel** | El proveedor de identidad incluido | Gestiona el inicio de sesión. Tiene su propia base de datos. |
| **zitadel_db** | PostgreSQL del proveedor de identidad | Separada de la base de datos de la aplicación. |

Con el proveedor de identidad incluido, un par de pequeños ayudantes puntuales se ejecutan en el primer
arranque para configurar el inicio de sesión automáticamente: se completan y terminan. Con tu propio
proveedor de identidad, los servicios de Zitadel se eliminan (consulta
[Proveedor de identidad](/help/deployment-operations-identity-provider)).

## Cómo encajan las piezas

- El navegador solo habla con **Caddy** por HTTPS. Caddy reenvía las peticiones de página a **web** y
  las peticiones de API a **api** por la red interna. Como la web llama a la API en la ruta relativa
  `/api`, una misma imagen funciona en cualquier dominio.
- **api** lee y escribe en **db** (PostgreSQL), envía trabajos en segundo plano a **valkey** y mantiene
  **meilisearch** sincronizado a medida que cambian los datos.
- **migrate** se ejecuta primero en cada despliegue: aplica las migraciones y una pequeña semilla
  idempotente, luego termina. La API espera a que finalice con éxito antes de arrancar.
- El inicio de sesión pasa por **zitadel** (o por tu propio proveedor). La API y la web validan los
  tokens que emite.

## Dos bases de datos — ambas importan

La pila ejecuta **dos** bases de datos PostgreSQL: la de la aplicación (**db**) y la propia del proveedor
de identidad (**zitadel_db**). Están separadas a propósito para poder respaldarlas de forma independiente
y para que cambiar a tu propio proveedor de identidad sea una eliminación limpia.

Esta separación es lo más importante que hay que entender para la recuperación ante desastres: respaldar
solo la base de datos de la aplicación deja a todo el mundo **sin poder iniciar sesión**, porque las
cuentas viven en la base de datos del proveedor de identidad. Consulta
[Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

## Qué es y qué no es objetivo de copia de seguridad

- **db** y **zitadel_db** guardan estado real: **respalda ambas.**
- **meilisearch** es reconstruible: su índice se rehace desde las bases de datos con un comando de
  reindexado, así que sus datos no necesitan copia.
- **valkey** solo guarda el estado de los trabajos en curso (PostgreSQL es el sistema de registro),
  así que tampoco es objetivo de copia. Sus datos sobreviven a los reinicios para no perder trabajos
  en cola.
- **caddy** vuelve a obtener sus certificados automáticamente, por lo que su estado no necesita copia.

## Límites de recursos y registros

Cada contenedor de larga duración tiene un tope modesto de memoria y CPU y una política de rotación de
registros, de modo que un servicio descontrolado no pueda agotar el servidor y los registros no llenen
el disco con el tiempo. Ajusta los límites a tu máquina si un servicio se queda corto — vigila
`docker stats`. La guía completa de dimensionamiento está en el runbook de despliegue autoalojado.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Proveedor de identidad](/help/deployment-operations-identity-provider)
- [Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls)
- [Resolución de problemas](/help/deployment-operations-troubleshooting)

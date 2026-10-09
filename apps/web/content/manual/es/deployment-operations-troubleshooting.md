---
title: Resolución de problemas
order: 6
category: deployment-operations
subcategory: troubleshooting
---

# Resolución de problemas

Síntomas habituales al levantar o ejecutar la pila en contenedores, y qué comprobar. Ejecuta todos los
comandos desde la raíz del repositorio. Un atajo cómodo para la larga invocación de producción:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
$DC ps          # ¿están todos los servicios arriba? ¿terminaron con 0 los trabajos puntuales?
$DC logs -f api # sigue los registros de un servicio
```

## Primero, dos respuestas que *no* son fallos

- **`/api/...` devuelve 401 sin haber iniciado sesión.** Correcto. Toda ruta de la API requiere
  autenticación; un `401` sin autenticar significa que la protección funciona, no que la instalación
  esté rota.
- **`/api/docs` devuelve 404.** También correcto. La documentación interactiva de la API no se sirve a
  propósito en el origen público.

## La API no arranca

La API solo arranca después de que el trabajo puntual de **migración** termine con éxito. Si la API no
levanta, comprueba primero la migración:

```sh
$DC logs migrate
```

Causas habituales: un `DATABASE_URL` incorrecto, que la base de datos aún no esté sana, o una migración
que realmente falla. Si la API termina de inmediato quejándose de que `DATABASE_URL` no está definida,
asegúrate de que `infra/env/.env.prod` existe y lo define (host `db`, coincidiendo con las credenciales
de Postgres).

## Postgres no arranca

Si la contraseña de la base de datos está **vacía**, PostgreSQL se niega a arrancar por diseño. Define
una contraseña robusta y no vacía en el archivo de entorno.

## La importación en segundo plano se cuelga o la API registra «conexión rechazada» con el intermediario

El intermediario de trabajos en segundo plano (Valkey) no es accesible. La causa habitual es que falte
`REDIS_URL` en el archivo de entorno — común en instancias creadas antes de que existieran los
trabajadores en segundo plano, porque el arranque guiado solo lo escribe en una instalación desde cero —
en un archivo existente no añade más que unas pocas claves generadas (consulta
[Actualizaciones](/help/deployment-operations-upgrades)). Añádelo y recrea la API:

```sh
grep -q '^REDIS_URL=' infra/env/.env.prod || echo 'REDIS_URL=redis://valkey:6379' >> infra/env/.env.prod
$DC up -d api
```

El intermediario es accesible como `valkey:6379` en la red interna, nunca como `localhost`. La API ya no
se desborda ante esta mala configuración; registra la URL del intermediario resuelta (contraseña
oculta) al arrancar y devuelve un error limpio en la importación en lugar de colgarse.

## Problemas de inicio de sesión

- **El script de arranque o la API se niegan a arrancar por restos del proveedor de identidad
  incluido.** Esta versión ya no lo incluye, y no se cambió nada. Consulta
  [Actualizaciones](/help/deployment-operations-upgrades#retiro-del-proveedor-de-identidad-incluido).
- **OIDC: la API no arranca.** Con `AUTH_MODE=oidc` la API exige `OIDC_ISSUER` y `OIDC_JWKS_URI`, y su
  error indica cuál falta. Defínela en el archivo de entorno y recrea la API.
- **OIDC: tu proveedor rechaza el inicio de sesión.** Comprueba que la URI de redirección registrada en
  el proveedor sea exactamente `https://tudominio.com/api/auth/callback/oidc`, y que `AUTH_ISSUER` y
  `OIDC_ISSUER` coincidan con el issuer que anuncia tu proveedor. Consulta
  [Proveedor de identidad](/help/deployment-operations-identity-provider).

## El navegador avisa sobre el certificado (local)

En un despliegue tipo producción local, Caddy usa su autoridad de certificación interna, en la que los
navegadores no confían por defecto. Acepta el aviso, o confía una vez en el certificado raíz de Caddy —
consulta [Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls). En un dominio real con
Let's Encrypt no hay aviso.

## Un servicio se mata o se reinicia

Cada contenedor tiene un tope de memoria para que un servicio descontrolado no pueda tumbar el servidor.
Si un servicio se queda corto, vigila `docker stats` y sube su límite según tu máquina. La importación
de documentos en segundo plano se ejecuta en un proceso hijo aislado con su propio tope de memoria; si
subes ese tope para documentos muy grandes, sube el límite de memoria de la API en consecuencia para que
quien alcance el tope sea el hijo y no toda la API.

## La búsqueda no devuelve nada tras un despliegue

El índice de búsqueda es reconstruible y puede necesitar un llenado puntual tras el primer despliegue (o
tras añadir la búsqueda a una instancia existente). Ejecútalo mediante la imagen de migración:

```sh
$DC run --rm migrate bun run reindex:all
```

Entre despliegues el índice se autorrepara de forma periódica, así que normalmente no necesitas
reindexar a mano.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls)
- [Actualizaciones](/help/deployment-operations-upgrades)

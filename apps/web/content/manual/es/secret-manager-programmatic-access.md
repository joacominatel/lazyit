---
title: Acceso programático (cuentas de servicio)
category: secret-manager
subcategory: programmatic-access
order: 5
---

# Acceso programático (cuentas de servicio)

A veces un **script o una tubería de despliegue** necesita los secretos de una bóveda — un job de CI que
inyecta variables de entorno, una corrida de Ansible, un contenedor que lee su configuración al arrancar.
En lugar de que una persona copie y pegue los valores, una **cuenta de servicio** puede traerlos por la API
y una pequeña herramienta de línea de comandos los descifra en tu máquina hacia un archivo `.env`.

La garantía importante no cambia: **lazyit sigue sin poder leer tus secretos.** El servidor solo devuelve
datos **cifrados**; el descifrado ocurre en tu máquina, con el token de la cuenta de servicio. Mirá
[Modelo de seguridad](/help/secret-manager) para entender qué significa "el servidor no puede leerlos".

## Cómo funciona, en una imagen

Una cuenta de servicio obtiene su **propia clave de cifrado**, igual que una persona. Después **agregás la
cuenta de servicio a una bóveda** (la misma acción de "agregar miembro" que usás con personas). A partir de
ahí, una herramienta sin interfaz puede traer los secretos cifrados de esa bóveda y descifrarlos localmente:

1. La clave privada de la cuenta de servicio se protege con su **token** (la credencial `lzit_sa_…` que se
   muestra una sola vez cuando la creás).
2. Agregar la cuenta de servicio a una bóveda envuelve la clave de esa bóveda hacia la cuenta de servicio —
   el mismo otorgamiento de siempre. Solo podés hacerlo para una bóveda **que ya podés leer**.
3. La herramienta `lazyit-fetch` envía el token a la API, recibe **solo texto cifrado** y lo descifra en la
   máquina de despliegue.

Como la clave es **por bóveda**, un token puede leer **solo la(s) bóveda(s) a la(s) que se agregó esa cuenta
de servicio** — nunca todo. Si querés mayor aislamiento, poné los secretos sensibles en una **bóveda aparte**
y agregá la cuenta de servicio solo ahí.

## Paso 1 — Crear la cuenta de servicio y su clave

1. En **Configuración → Cuentas de servicio**, creá una cuenta de servicio y otorgale el permiso **Traer
   secretos programáticamente** (`secret:fetch`). Es el único permiso de secretos que una cuenta de servicio
   puede tener — nunca se le pueden dar los permisos humanos de "ver" o "gestionar".
2. Al crearla, la app genera un **par de claves de cifrado** para **todas** las cuentas de servicio (no solo
   las de Fetch), protegido con su token. **Copiá el token ahora** — se muestra una sola vez y es lo que la
   herramienta usa para descifrar. Si lo perdés, **rotá el token** (ver abajo), lo que reemite la clave.

> **Cuentas de servicio antiguas sin clave.** Una cuenta de servicio creada antes de esta función no tiene
> clave de cifrado, así que todavía no se puede agregar a una bóveda (el diálogo de acceso te lo indicará).
> **Rotá su token** en **Configuración → Cuentas de servicio** — eso le genera una clave. Rotar siempre
> reemite la clave, por lo que **quita la cuenta de servicio de todas las bóvedas** a las que pertenecía;
> volvé a agregarla después (Paso 2).

## Paso 2 — Agregar la cuenta de servicio a una bóveda

1. Abrí la bóveda en el **Gestor de secretos** y usá **Agregar cuenta de servicio** en el área de miembros.
2. Elegí la cuenta de servicio. Tu navegador vuelve a cifrar la clave de la bóveda hacia la clave de la
   cuenta de servicio — así que, como siempre, **solo podés otorgar una bóveda que vos mismo podés leer.**

La cuenta de servicio aparece ahora como miembro máquina de esa bóveda. Podés revocarla cuando quieras con
la acción de quitar miembro (esto detiene lecturas futuras; rotá la credencial subyacente si sospechás que
el token se filtró).

## Paso 3 — Traer secretos en la máquina de despliegue

La herramienta de línea de comandos **`lazyit-fetch`** vive en el monorepo (`packages/fetch-cli`) y **no**
se publica en un registro de paquetes — así que no hay instalación con `npx`/`bunx`. En su lugar corrés un
**binario autónomo** compilado a partir de ella. Desde una copia del monorepo, generá los binarios una vez:

```sh
# Compila dist/lazyit-fetch-x64 y dist/lazyit-fetch-arm64 (ejecutables Linux autocontenidos).
bun run --filter @lazyit/fetch-cli compile
```

Copiá el binario que coincida con la arquitectura de tu servidor (por ej. `lazyit-fetch-x64`) a la máquina
de despliegue. Ahí **no necesita Bun ni Node**. Después dale el token, la URL de la API y el id de la bóveda:

```sh
# El token se lee de una variable de entorno para que no quede en el historial del shell ni en `ps`.
export LAZYIT_SA_TOKEN="lzit_sa_…"

# Escribir un archivo .env en el directorio actual:
./lazyit-fetch-x64 --api https://lazyit.example.com/api --vault <vaultId> --out .env

# …o imprimir a stdout para componer con otras herramientas:
./lazyit-fetch-x64 --api https://lazyit.example.com/api --vault <vaultId> > .env

# Listar las bóvedas que esta cuenta de servicio puede traer:
./lazyit-fetch-x64 --api https://lazyit.example.com/api --list

# Verificar el cifrado de la herramienta sin tocar el servidor (sin API ni token):
./lazyit-fetch-x64 --self-check
```

> **Correr desde una copia (para probar).** Si ya tenés el monorepo, podés correr la herramienta
> directamente desde el código con Bun en lugar de compilar — práctico mientras probás:
> `bun packages/fetch-cli/src/index.ts --api <url> --vault <vaultId>`.

Cada secreto se convierte en una línea, `HANDLE=valor`. El **handle** se pasa a mayúsculas y los caracteres
no alfanuméricos se vuelven `_`, así que `prod-db-password` queda `PROD_DB_PASSWORD`. Elegí handles que sean
buenos nombres de variables de entorno.

## Qué ve el servidor y qué no

- El servidor devuelve **solo texto cifrado** — los valores cifrados más las claves cifradas que la
  herramienta necesita. **Nunca** devuelve un valor en texto plano, y nunca descifra uno.
- Cada traída programática queda **registrada** — qué cuenta de servicio leyó qué bóveda, y cuándo.
- El **token es la clave.** Cualquiera que lo tenga puede descifrar los secretos de esa bóveda, así que
  tratalo como a los secretos mismos: guardalo en una variable de entorno segura, limitá cada cuenta de
  servicio a las bóvedas que necesita, y rotalo si pudo haberse filtrado.

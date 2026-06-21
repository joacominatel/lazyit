---
title: Bóvedas y miembros
category: secret-manager
subcategory: vaults-members
order: 1
---

# Bóvedas y miembros

El **Gestor de Secretos** es donde tu equipo guarda los **secretos compartidos**: las credenciales que
un equipo de IT se pasa entre sí, como una contraseña root compartida, una clave precompartida de VPN o
el acceso al registrador de dominios. Es un área distinta de la Base de Conocimiento. La **Base de
Conocimiento** guarda tus runbooks; el **Gestor de Secretos** guarda las credenciales que esos runbooks
necesitan. Accedes a él desde el área del Gestor de Secretos en la aplicación.

Los secretos nunca se almacenan donde lazyit pueda leerlos: se cifran en tu navegador antes de
guardarse, y lazyit no puede descifrarlos. Consulta el [Modelo de seguridad](/help/secret-manager) para
ver qué significa esto en la práctica.

## Bóvedas frente a la Base de Conocimiento

Una **bóveda** es un contenedor con nombre para secretos, compartido con una lista de **miembros**.
Solo los miembros de una bóveda pueden leer los secretos que contiene.

| | Base de Conocimiento | Gestor de Secretos |
| --- | --- | --- |
| Guarda | Artículos, runbooks, documentación | Credenciales y valores secretos |
| Se comparte por | Acceso a la carpeta | Membresía de la bóveda |
| ¿lazyit puede leerlo? | Sí (renderiza el artículo) | **No** — los valores se cifran en tu dispositivo |

Un artículo de la Base de Conocimiento puede **apuntar a** un secreto sin copiar su valor dentro del
artículo — consulta [Referencias a secretos](/help/secret-manager-secret-references).

## Crear una bóveda

1. Abre el Gestor de Secretos. La primera vez, configuras una contraseña — consulta
   [Contraseñas y claves de recuperación](/help/secret-manager-passwords-recovery-keys).
2. Elige **Nueva bóveda**, dale un nombre corto y descriptivo (por ejemplo, "Credenciales de
   producción") y créala. Pasas a ser su primer miembro automáticamente.

El **nombre** de la bóveda y su **lista de miembros** son visibles para los administradores y para
quien gestione el Gestor de Secretos: son etiquetas, no secretos. **Nombra las bóvedas de forma clara y
no pongas un secreto en el nombre.**

## Agregar secretos a una bóveda

Abre una bóveda y elige **Agregar secreto**. Cada secreto tiene:

- una **etiqueta** — un nombre legible, por ejemplo "Clave API de Cloudflare";
- un **identificador** (handle) — un identificador corto (letras minúsculas, números, guiones bajos,
  puntos y guiones), que se usa para referenciar el secreto desde artículos de la Base de Conocimiento;
- un **valor secreto** — la credencial en sí.

El valor se cifra en tu navegador antes de almacenarse. Para leer un secreto más tarde, abre la bóveda y
elige **Revelar valor**; **Copiar valor** lo coloca en tu portapapeles. Un valor revelado se vuelve a
ocultar a los pocos segundos, y un valor copiado se **borra del portapapeles automáticamente a los 30
segundos aproximadamente** para que el texto plano no quede ahí después de pegarlo. Este borrado
automático es de **mejor esfuerzo**: tu navegador puede no permitirlo (por ejemplo sobre HTTP plano, o si
otra app o un gestor de portapapeles ya capturó el valor), así que considéralo una comodidad, no una
garantía — pega cuanto antes. Puedes editar la etiqueta o el identificador de un secreto, reemplazar su
valor o eliminarlo.

## Buscar en una bóveda

Una bóveda con más de unos pocos secretos muestra un **cuadro de búsqueda** sobre la lista. Filtra por
**etiqueta** y **handle** a medida que escribes — los nombres no secretos, nunca los valores. La búsqueda
no descifra nada; solo acota lo que se ve en pantalla.

## Importar en masa desde un archivo .env

Para incorporar los secretos de una aplicación de una sola vez en lugar de uno por uno, abre una bóveda y
elige **Importar**. Pega tus líneas `CLAVE=valor` (o **sube un archivo `.env`**) y lazyit muestra una
**vista previa** antes de guardar nada:

- cuántas claves son **nuevas** y se importarán;
- cuántas se **omiten** porque ya existe un secreto con ese handle — la importación **nunca sobrescribe**
  un secreto existente;
- las líneas que no se pudieron interpretar (se ignoran).

Entiende el formato `.env` habitual: `CLAVE=valor`, `export CLAVE=...`, valores entre comillas simples o
dobles, `# comentarios` y líneas en blanco. Cada valor importado se **cifra en tu navegador** antes de
almacenarse — igual que al agregar un secreto a mano, así lazyit nunca ve el texto plano.

## Exportar una bóveda a un archivo .env

Para respaldar una bóveda, sembrar el `.env` de una app o entregar secretos a una persona desarrolladora,
abre una bóveda y elige **Exportar**. lazyit **descifra los secretos en tu navegador** y los descarga como
un archivo `.env`.

> **Exportar escribe tus secretos en TEXTO PLANO en tu dispositivo.** Cualquiera que pueda leer el archivo
> descargado puede leer los secretos. Guárdalo en un lugar seguro y elimínalo cuando termines. lazyit
> registra *que* exportaste (quién, qué bóveda, cuándo) para la auditoría — pero, fiel al modelo de
> seguridad, nunca ve los valores en sí.

## Agregar y revocar miembros

Las bóvedas se comparten gestionando **miembros**:

- **Conceder acceso** — abre una bóveda, elige **Conceder acceso** y selecciona a una persona. Obtiene
  la capacidad de leer los secretos de la bóveda. Solo puedes conceder acceso a una bóveda de la que tú
  mismo seas miembro — no puedes compartir un acceso que no tienes. La persona debe haber abierto el
  Gestor de Secretos y configurado su propia contraseña al menos una vez; si no lo ha hecho, lazyit te
  indica que se lo pidas primero.
- **Revocar acceso** — elige **Revocar acceso** junto a un miembro para quitarlo. Ya no podrá leer los
  secretos de la bóveda. Una bóveda siempre debe conservar al menos un miembro, así que no puedes
  revocar al último — agrega otro miembro primero.

> **Revocar detiene el acceso futuro; no "des-cuenta" un secreto.** Quitar a un miembro le impide leer
> la bóveda de ahí en adelante, pero no puede deshacer un valor que ya vio. Si una credencial pudo
> quedar expuesta, la solución real es la de siempre: **cambiar la credencial subyacente** (por ejemplo,
> rotar la contraseña real).

## No dejes una bóveda importante con un solo miembro

lazyit te avisa cuando una bóveda tiene un **solo miembro**. Una bóveda con un único miembro no tiene a
nadie que pueda restaurar el acceso si esa persona pierde sus credenciales — consulta el
[Modelo de seguridad](/help/secret-manager) para conocer el único caso que no se puede recuperar.
**Agrega un segundo miembro a cualquier bóveda que importe.**

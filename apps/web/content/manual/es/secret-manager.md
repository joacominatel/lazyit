---
title: Modelo de seguridad
order: 3
category: secret-manager
subcategory: security-model
---

# Modelo de seguridad

El Gestor de Secretos guarda los **secretos compartidos** de tu equipo en **bóvedas** que solo sus
miembros pueden leer. Lo que lo diferencia de cualquier otro sitio donde podrías guardar una contraseña
es la garantía de seguridad que tiene detrás. Esta página explica esa garantía, de qué te protege y el
único caso del que no puede salvarte.

Para las tareas del día a día, consulta [Bóvedas y miembros](/help/secret-manager-vaults-members) y
[Contraseñas y claves de recuperación](/help/secret-manager-passwords-recovery-keys).

## lazyit no puede leer tus secretos

> **El Gestor de Secretos está cifrado de extremo a extremo.** Los valores de los secretos solo son
> legibles en tu navegador, por un miembro de la bóveda. lazyit los almacena de una forma que **no
> puede** descifrar — ni el servidor, ni un administrador, ni una copia de seguridad de la base de datos
> pueden revelar el valor de un secreto. Ese es el propósito de la función, y define cómo funciona la
> recuperación.

El cifrado y el descifrado ocurren **en tu dispositivo**. Tu contraseña y tu clave de recuperación nunca
salen de tu navegador. El trabajo del servidor es **almacenar y servir** los datos cifrados y hacer
cumplir *quién puede obtener qué bóveda*; es estructuralmente incapaz de producir un valor en claro.

Es una decisión deliberada. Como no hay una llave maestra en el servidor, **no hay puerta trasera** — y
eso es precisamente lo que hace que la garantía sea confiable.

## Qué se oculta y qué no a lazyit

No todo se oculta — algunas etiquetas tienen que ser visibles para que la aplicación pueda mostrarte una
lista y para que los administradores puedan gestionar el acceso.

| Visible para lazyit (etiquetas / metadatos) | Nunca legible por lazyit |
| --- | --- |
| **Nombres** de bóvedas y **listas de miembros** | **Valores** de los secretos |
| **Etiquetas** e **identificadores** de los secretos | Tu **contraseña** y tu **clave de recuperación** |

Como los nombres, los miembros y los identificadores son visibles, **nombra las bóvedas y los secretos
de forma clara — nunca pongas un valor secreto en una etiqueta o un nombre.**

## Dos capas de acceso

Llegar al Gestor de Secretos y descifrar una bóveda son **dos cosas distintas**:

1. **Permiso para entrar** — un administrador concede la capacidad del Gestor de Secretos. Esto te
   permite llegar al Gestor de Secretos y ver que existen bóvedas (sus nombres y miembros). Por sí solo
   **no** revela ningún valor secreto.
2. **Membresía de la bóveda** — para realmente **descifrar** los secretos de una bóveda, debes ser
   **miembro** de esa bóveda (consulta [Bóvedas y miembros](/help/secret-manager-vaults-members)).

Estas pueden no coincidir, y hay una consecuencia importante: **quitarle a alguien el permiso para
entrar no lo deja fuera, criptográficamente, de una bóveda de la que ya era miembro.** El servidor
rechazará sus solicitudes, pero la única manera de cortar de verdad el acceso a una bóveda es **revocar
su membresía** y, ante un compromiso real, **rotar la credencial subyacente**. Un administrador puede
ver el nombre y los miembros de cada bóveda y gestionar quién puede entrar, pero un administrador al que
nunca se hizo miembro de una bóveda **no puede leer sus secretos**.

## Recuperar el acceso — y el único caso en que no se puede

Como lazyit no puede leer tus secretos, la recuperación es algo que haces tú y tu equipo, no algo que el
servidor pueda hacer por ti. Hay tres situaciones:

- **Perdiste tu contraseña pero tienes tu clave de recuperación.** Usa la clave de recuperación para
  **restablecer tu contraseña**
  ([Contraseñas y claves de recuperación](/help/secret-manager-passwords-recovery-keys)). Ya estás
  dentro, y tu acceso a las bóvedas queda intacto.
- **Perdiste ambas, pero la bóveda tiene otros miembros.** Configúrate con una contraseña y una clave de
  recuperación nuevas, y un miembro actual de cada bóveda **te concede acceso de nuevo**. Nadie llega a
  conocer tu contraseña al hacerlo — simplemente vuelve a compartir la bóveda con tu nueva identidad.
- **Perdiste ambas y eras el único miembro de la bóveda.** Este es el único caso sin retorno. Si el
  **único** miembro de una bóveda pierde **ambas** —su contraseña y su clave de recuperación—, **la
  bóveda no se puede recuperar**: ni un compañero, ni un administrador, ni lazyit. No hay puerta trasera;
  eso es lo que hace que el cifrado sea confiable.

## Protégete de la pérdida permanente

Dos hábitos sencillos evitan el caso irrecuperable:

- **Mantén tu clave de recuperación segura y fuera del sistema.** Es tu respaldo personal — guárdala
  donde una brecha del servidor o una pérdida de la base de datos no la alcancen. Se muestra una sola
  vez, durante la configuración inicial.
- **No dejes una bóveda importante con un solo miembro.** Agrega un segundo miembro a cualquier bóveda
  relevante para que un compañero pueda restaurar tu acceso si alguna vez pierdes tus llaves. lazyit te
  avisa cuando una bóveda tiene un solo miembro — hazle caso antes de que sea tarde.

## Cuando un secreto puede haber quedado expuesto

Quitar a un miembro, o incluso eliminar un secreto, detiene las lecturas **futuras** a través de lazyit
— no "des-cuenta" un valor que alguien ya vio. Si sospechas que una credencial quedó expuesta, la
solución real es la de siempre: **cambiar la credencial subyacente** (rotar la contraseña real, reemitir
la clave) en su origen.

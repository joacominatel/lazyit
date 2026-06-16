---
title: Gestor de Secretos
order: 1
section: Servicios
---

# Gestor de Secretos

El Gestor de Secretos es donde tu equipo guarda los **secretos compartidos** — eso que un equipo de
IT se pasa entre sí: una contraseña root compartida, una clave precompartida de VPN, el acceso al
registrador de dominios. Es distinto de la Base de Conocimiento: la Base de Conocimiento guarda tus
runbooks, el Gestor de Secretos guarda las credenciales que esos runbooks necesitan.

Los secretos viven en **bóvedas**. Una bóveda es un contenedor con nombre y una lista de
**miembros**. Solo los miembros de una bóveda pueden leer los secretos que contiene.

> **lazyit no puede leer tus secretos.** El Gestor de Secretos está cifrado de extremo a extremo. Los
> valores de los secretos solo son legibles en tu navegador, por un miembro de la bóveda — lazyit los
> almacena de una forma que no puede descifrar. Ni el servidor, ni un administrador, ni una copia de
> seguridad de la base de datos pueden revelar el valor de un secreto. Ese es el propósito de la
> función, y define cómo funciona la recuperación (más abajo).

## Tu contraseña y tu clave de recuperación

Para usar el Gestor de Secretos configuras dos credenciales, **una sola vez**, la primera vez que lo
abres. Son específicas del Gestor de Secretos y **no** son tu contraseña de inicio de sesión.

- **Contraseña** — tu **llave del día a día**. La ingresas para desbloquear el Gestor de Secretos en
  una sesión. Puedes **cambiarla** cuando quieras (necesitas tu contraseña actual para hacerlo).
- **Clave de recuperación** — tu **llave de respaldo**. Es un código largo de un solo uso que se
  muestra con el formato `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Su única función es **restablecer tu
  contraseña** si la olvidas. No es una segunda llave del día a día — no la usas para desbloquear a
  diario.

> **La clave de recuperación se muestra exactamente una vez.** lazyit la muestra cuando configuras
> por primera vez el Gestor de Secretos y **no la vuelve a mostrar nunca** — no se almacena en ningún
> lugar que lazyit pueda leer. Guárdala en un sitio seguro y fuera del sistema: un gestor de
> contraseñas, o una copia impresa en un lugar protegido. Si pierdes tu contraseña y no tienes tu
> clave de recuperación, nadie podrá restablecerla por ti.

Piénsalo así: la **contraseña es la puerta que usas todos los días**, y la **clave de recuperación es
la llave maestra en la caja fuerte** que te permite poner una cerradura nueva si alguna vez pierdes
tu llave diaria.

## Uso diario

- **Desbloquear** — ingresa tu contraseña para desbloquear el Gestor de Secretos durante tu sesión.
- **Cambiar tu contraseña** — ingresa tu contraseña actual y luego una nueva. Tu acceso a cada bóveda
  se conserva; nada más cambia.
- **Restablecer tu contraseña** — si olvidaste tu contraseña, usa tu **clave de recuperación** para
  definir una nueva. Tras un restablecimiento quedas desbloqueado de inmediato.

## Compartir una bóveda

Las bóvedas se comparten agregando **miembros**:

- **Agregar un miembro** — cualquier miembro actual de una bóveda puede conceder acceso a otra
  persona. Solo puedes agregar a alguien a una bóveda que tú mismo puedas leer — no puedes compartir
  un acceso que no tienes.
- **Revocar un miembro** — quita a alguien de una bóveda y ya no podrá leer sus secretos.

> Revocar a un miembro detiene el acceso futuro a través de lazyit. No "des-cuenta" un secreto que
> alguien ya leyó. Si una credencial pudo haber quedado expuesta, la solución real es la de siempre:
> **cambiar la credencial subyacente** (por ejemplo, rotar la contraseña real).

## Recuperar el acceso — y el único caso en que no se puede

Como lazyit no puede leer tus secretos, la recuperación es algo que haces tú y tu equipo, no algo que
el servidor pueda hacer por ti. Hay tres situaciones:

- **Perdiste tu contraseña pero tienes tu clave de recuperación.** Usa la clave de recuperación para
  restablecer tu contraseña. Ya estás dentro.
- **Perdiste ambas, pero la bóveda tiene otros miembros.** Otro miembro puede **restaurar tu acceso**
  a cada bóveda: configuras una contraseña y una clave de recuperación nuevas, y un compañero vuelve a
  compartir cada bóveda contigo. Nadie llega a conocer tu contraseña al hacerlo.
- **Perdiste ambas y eras el único miembro de la bóveda.** Este es el único caso sin retorno. Si el
  **único** miembro de una bóveda pierde **ambas** —su contraseña y su clave de recuperación—, **la
  bóveda no se puede recuperar**: ni un compañero, ni un administrador, ni lazyit. No hay puerta
  trasera; eso es lo que hace que el cifrado sea confiable.

### Protégete de la pérdida permanente

Dos hábitos sencillos evitan el caso irrecuperable:

- **Mantén tu clave de recuperación segura y fuera del sistema.** Es tu respaldo personal — guárdala
  donde una brecha del servidor o una pérdida de la base de datos no la alcancen.
- **No dejes una bóveda importante con un solo miembro.** Agrega un segundo miembro a cualquier
  bóveda relevante para que un compañero pueda restaurar el acceso si alguna vez pierdes tus llaves.
  lazyit te avisa cuando una bóveda tiene un solo miembro — hazle caso antes de que sea tarde.

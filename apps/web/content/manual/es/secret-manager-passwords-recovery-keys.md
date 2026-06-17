---
title: Contraseñas y claves de recuperación
category: secret-manager
subcategory: passwords-recovery-keys
order: 2
---

# Contraseñas y claves de recuperación

Para usar el Gestor de Secretos configuras dos credenciales, **una sola vez**, la primera vez que lo
abres. Son específicas del Gestor de Secretos y **no** son tu contraseña de inicio de sesión. Juntas
protegen tu acceso a cada bóveda a la que perteneces.

- **Contraseña** — tu **llave del día a día**. La ingresas para desbloquear el Gestor de Secretos en una
  sesión, y de nuevo para revelar un secreto en línea dentro de un artículo de la Base de Conocimiento.
  Puedes **cambiarla** cuando quieras.
- **Clave de recuperación** — tu **llave de respaldo**. Es un código largo de un solo uso que se muestra
  con el formato `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Su única función es **restablecer tu contraseña** si
  la olvidas. No es una segunda llave del día a día — no la usas para desbloquear a diario.

Piénsalo así: la **contraseña es la puerta que usas todos los días**, y la **clave de recuperación es la
llave maestra en la caja fuerte** que te permite poner una cerradura nueva si alguna vez pierdes tu
llave diaria.

## Configuración inicial

La primera vez que abres el Gestor de Secretos, lazyit te pide **configurar tu contraseña**. Elige algo
fuerte y memorable (al menos 8 caracteres). Tu contraseña nunca se envía al servidor.

Inmediatamente después, lazyit te muestra tu **clave de recuperación**.

> **La clave de recuperación se muestra exactamente una vez.** lazyit la muestra durante la
> configuración inicial y **no la vuelve a mostrar nunca** — no se almacena en ningún lugar que lazyit
> pueda leer. Guárdala en un sitio seguro y **fuera del sistema**: un gestor de contraseñas, o una copia
> impresa en un lugar protegido. Confirmas que la guardaste antes de continuar. Si más adelante pierdes
> tu contraseña y no tienes tu clave de recuperación, nadie podrá restablecerla por ti.

## Desbloquear en el día a día

Cuando vuelves, el Gestor de Secretos está **bloqueado**. Ingresa tu **contraseña** para desbloquearlo
durante tu sesión. Puedes bloquearlo de nuevo en cualquier momento, lo que borra la clave de la memoria.
La clave de recuperación **no** se usa aquí — solo tu contraseña desbloquea a diario.

## Cambiar tu contraseña

Usa **Cambiar contraseña**, ingresa tu **contraseña actual** y luego elige una nueva. Tu acceso a cada
bóveda se conserva y tu clave de recuperación no se ve afectada — nada más cambia. Esta es la forma
habitual de rotar tu contraseña del Gestor de Secretos.

## Restablecer una contraseña olvidada

Si olvidaste tu contraseña pero todavía tienes tu **clave de recuperación**, elige
**¿Olvidaste tu contraseña?** en la pantalla de desbloqueo. Ingresa tu clave de recuperación y define
una nueva contraseña. **Inicias sesión automáticamente** una vez restablecida — tu acceso a cada bóveda
queda intacto.

Algunas cosas que conviene saber:

- La clave de recuperación **restablece** la contraseña; no es una forma de iniciar sesión directamente.
- La clave de recuperación queda **fija al configurar por primera vez** el Gestor de Secretos. No se
  puede regenerar con tu contraseña, así que mantén a salvo la copia que guardaste al inicio.
- Quien tenga tu clave de recuperación puede restablecer tu contraseña y tomar el control de tus
  bóvedas — por eso justamente es de alta entropía, se muestra una sola vez y está pensada para vivir
  fuera del sistema, no para el uso diario.

## Si perdiste ambas

Si perdiste **ambas** —tu contraseña y tu clave de recuperación—, elige
**Perdí tanto mi contraseña como mi clave de recuperación** en la pantalla de desbloqueo. Esto te
configura con una identidad completamente nueva. **Perderás el acceso a todas las bóvedas hasta que un
miembro actual de cada bóveda te conceda acceso de nuevo** — coordínate con tu equipo antes de hacerlo.
Lo que ocurre después, y el único caso que no puede recuperarse en absoluto, se explica en el
[Modelo de seguridad](/help/secret-manager).

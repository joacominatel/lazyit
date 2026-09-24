---
title: Aprobar cambios
order: 1
category: ai-assistant
subcategory: approvals
---

# Aprobar cambios

Cada cambio que el asistente quiere hacer — crear, editar, asignar, archivar, otorgar o revocar accesos —
espera por vos. Aparece en el chat como una **tarjeta**, y no pasa nada hasta que elegís **Aprobar**. Esta
página explica cómo leer una tarjeta y qué pasa cuando decidís.

## Leer una tarjeta

La tarjeta la arma lazyit a partir del cambio exacto que se va a ejecutar — **no** a partir de lo que el
asistente escribió en el chat. Si alguna vez no coinciden, confiá en la tarjeta.

De arriba hacia abajo:

1. **El tipo de cambio** — *Cambio propuesto*, o *Cambio sensible* para cambios en accesos, roles,
   identidad o inicio de sesión de personas, y un sello de estado (**Pendiente**, **Hecho**, **Rechazado**…).
2. **Qué va a pasar**, en una oración — por ejemplo *"Dar a Ana Ruiz acceso Admin a VPN. Esto dispara el
   aprovisionamiento automático mediante el workflow configurado para VPN."*
3. **Se aplica a** — el elemento que cambia, con un enlace.
4. **Antes → después** — cada campo que cambia, con el valor actual tachado y el nuevo al lado. Valores como
   contraseñas se muestran como **Oculto**, nunca en claro.
5. **También afecta a** — otros elementos que toca el cambio, como "También afecta a 3 asignaciones".
6. **Antes de aprobar** — advertencias en palabras simples, como:
   - *Crea un acceso en un sistema externo mediante una automatización.*
   - *También revoca los accesos vinculados.*
   - *Envía notificaciones a personas.*
   - *No se puede deshacer.*
   - *Afecta a una aplicación marcada como crítica.*
7. **Te espera hasta las…** — una propuesta vence después de un rato (30 minutos por defecto). Después,
   pedíselo de nuevo al asistente.

El texto que escribieron otras personas — un artículo, una nota, la descripción de una aplicación — se muestra
como texto plano en *cursiva* para que lo distingas.

### "Basado en contenido escrito por otras personas"

Si el asistente leyó contenido que escribieron otras personas antes de proponer el cambio, la tarjeta muestra
una nota amarilla **Basado en contenido escrito por otras personas** con enlaces a lo que leyó. Un contenido
puede tener instrucciones pensadas para engañar a una IA. Verificá que el cambio sea realmente lo que **vos**
pediste antes de aprobarlo.

## Aprobar o rechazar

- **Aprobar** hace el cambio con tu cuenta, exactamente como se muestra. La tarjeta pasa a **Hecho**, y un
  botón **Abrir** te lleva al resultado. La página que tenés abierta se actualiza sola.
- **Rechazar** hace que no cambie nada. El asistente se entera de que lo rechazaste y puede sugerir otra
  cosa — decile qué cambiar.

Cada tarjeta se decide por separado; no hay "aprobar todo". Nada se aprueba presionando Enter en el cuadro de
mensaje.

## Cambios que necesitan tu contraseña

Algunos cambios te piden tu **contraseña de lazyit** en la tarjeta antes de poder aprobarlos:

- darle a alguien acceso o privilegios;
- cambiar el rol o la identidad de alguien;
- enviarle a alguien una forma de iniciar sesión;
- **cualquier cambio que el asistente haga sobre una aplicación marcada como crítica.**

Estas advertencias muestran la etiqueta **Requiere tu contraseña**. Escribí tu contraseña en la tarjeta y
elegí **Aprobar**. Confirma que realmente sos vos quien está frente al teclado; tu sesión sigue iniciada en
cualquier caso.

| Mensaje | Qué significa |
| --- | --- |
| Esa contraseña no es correcta | Escribila de nuevo. |
| Demasiadas contraseñas incorrectas. Probá de nuevo en … | Esperá el tiempo indicado; el botón Aprobar vuelve solo. |
| La confirmación con contraseña no está disponible con tu forma de iniciar sesión | Tu cuenta inicia sesión sin una contraseña de lazyit, así que este cambio no se puede aprobar desde el chat. Hacelo desde la página del elemento. |

## Cuando la tarjeta cambia

lazyit revisa el cambio de nuevo en el momento en que aprobás. Si algo cambió desde que se mostró la tarjeta
— por ejemplo, la aplicación se marcó como crítica mientras tanto — no se aplica nada. La tarjeta se
actualiza, las advertencias nuevas se resaltan con la etiqueta **Nuevo**, y te pide la contraseña si ahora la
necesita. Revisala y decidí de nuevo.

Otras cosas que podés ver:

| Mensaje | Qué significa |
| --- | --- |
| El elemento cambió después de la propuesta | Alguien lo editó mientras tanto. No se aplicó nada; el asistente lo revisa de nuevo y puede proponer un cambio actualizado. |
| Esta propuesta venció | Pasó demasiado tiempo. Pedila de nuevo si todavía querés el cambio. |
| Este cambio ya se decidió | Vos (u otra ventana tuya) ya lo aprobaste o rechazaste. |
| Se desactivó el asistente de IA | Un administrador desactivó el asistente; el cambio no se puede aprobar desde el chat. |

## Dónde quedan registrados los cambios aprobados

Un cambio aprobado se hace con tu cuenta, así que queda registrado como cualquier cambio que hacés vos: en el
historial del elemento y en el registro de actividad, a tu nombre. lazyit además guarda cada cambio que
propuso el asistente, y lo que decidiste, en un registro permanente de acciones de IA que se conserva aunque
elimines el chat.

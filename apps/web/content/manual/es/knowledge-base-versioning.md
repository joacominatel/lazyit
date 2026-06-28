---
title: Versionado
category: knowledge-base
subcategory: versioning
order: 4
---

# Versionado

La Base de conocimiento conserva un **historial** de cada artículo. Una edición nunca destruye en
silencio lo que decía antes un artículo: cada cambio se captura como una instantánea, de modo que
*"¿qué decía este runbook el trimestre pasado?"* siempre tiene respuesta.

## Cómo se registra el historial

Cada artículo lleva un **historial de versiones de solo anexado**. Se escribe una instantánea nueva
automáticamente cada vez que se guarda un cambio:

- **Crear** un artículo escribe la versión 1.
- **Editar** escribe una versión nueva **siempre que cambien de verdad el título, el cuerpo o el
  extracto**. Guardar una edición que no cambia nada relevante no añade una versión.
- **Publicar** y **despublicar** también escriben una versión, porque cambian el estado del artículo.

Cada instantánea es una copia completa y congelada del estado editable del artículo en ese momento —
su título, su cuerpo, su extracto y su estado de publicado/borrador — junto con **quién hizo el
cambio** y **cuándo**. Las versiones se numeran en orden, empezando por 1, y **nunca se editan ni se
eliminan**: el historial es permanente y crece en una entrada por cambio. Esto coincide con cómo
guarda el historial el resto de lazyit (el historial de activos, el libro de accesos): solo anexado,
por diseño.

## Por qué funciona así

Esto es **auditabilidad por defecto**. Como el cuerpo anterior siempre se conserva:

- Una edición equivocada nunca pierde el texto original.
- Puedes rendir cuentas de lo que decía un procedimiento en cualquier punto del pasado.
- Nada del artículo vivo corre riesgo cuando alguien lo actualiza.

## Cómo ver el historial de versiones

Abre cualquier artículo y desplázate hasta el panel **Historial de versiones** al final de la página.
Haz clic en **Historial** para abrir un panel lateral con todas las instantáneas guardadas, de más
reciente a más antigua. Cada fila muestra:

- El número de versión (1, 2, 3 …)
- El estado de borrador o publicado en ese momento
- Quién hizo el cambio y cuándo

Haz clic en **Ver** en cualquier fila para abrir una vista de solo lectura con el título y el
contenido completo de esa instantánea.

## Cómo restaurar una versión anterior

Si una edición salió mal, puedes **restaurar** una instantánea anterior. Abre el panel **Historial**
y haz clic en **Restaurar** en cualquier versión pasada (la última versión es el contenido vivo, así
que no hay nada que restaurar en ella). Confirma y lazyit vuelve a aplicar el **título, el cuerpo y
el extracto** de esa versión al artículo vivo.

Restaurar es en sí mismo una edición, así que sigue la misma regla de solo anexado: escribe una
versión **nueva** encima — nunca reescribe ni elimina el historial. Algunas cosas que conviene saber:

- Restaura el **contenido** (título, cuerpo, extracto). **No** cambia el **estado** de
  publicado/borrador del artículo — un artículo publicado sigue publicado y un borrador sigue siendo
  borrador. Para eso usa Publicar/Despublicar.
- Restaurar a un texto idéntico al actual no hace nada (no se escribe una versión nueva).
- Restaurar requiere **permiso de edición** y, como toda edición, debes ser el autor del artículo.

## Qué puedes y qué no puedes hacer

- **El historial se guarda para cada artículo, automáticamente** — no lo activas, y no puedes
  desactivarlo.
- **El historial de un borrador es tan privado como el borrador.** Las instantáneas de un borrador
  solo las ve su autor, igual que el propio borrador.

Como cada instantánea se conserva, el historial de un artículo solo crece — y es intencional. No se
poda nada, así que el rastro completo siempre está ahí.

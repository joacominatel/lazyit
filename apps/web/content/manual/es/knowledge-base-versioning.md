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

## Qué puedes y qué no puedes hacer hoy

- **El historial se guarda para cada artículo, automáticamente** — no lo activas, y no puedes
  desactivarlo.
- **No hay una acción de "restaurar a una versión anterior"** en la versión actual. El historial
  registra lo que decía un artículo; volver a aplicar una versión antigua sobre el artículo vivo aún
  no está disponible. Para revertir un cambio, edita el artículo de vuelta al texto anterior (lo que a
  su vez se convierte en una versión nueva).
- **El historial de un borrador es tan privado como el borrador.** Las instantáneas de un borrador
  solo las ve su autor, igual que el propio borrador.

Como cada instantánea se conserva, el historial de un artículo solo crece — y es intencional. No se
poda nada, así que el rastro completo siempre está ahí.

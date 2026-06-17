---
title: Esquema de etiquetas de activos
category: configuration
subcategory: asset-tag-scheme
order: 3
---

# Esquema de etiquetas de activos

El **esquema de etiquetas de activos** asigna automáticamente una etiqueta correlativa a los activos
nuevos — un prefijo, un número rellenado con ceros y un sufijo (por ejemplo `IT-0042-HW`). Está
**desactivado hasta que lo activas**, y una etiqueta que escribas a mano en un activo siempre tiene
prioridad. Se configura en **Configuración → Instancia** (solo administradores).

## Diseñar el esquema

El editor tiene cuatro campos y una **vista previa en vivo** que muestra exactamente cómo se verá la
siguiente etiqueta a medida que escribes:

- **Prefijo** — texto antes del número (p. ej. `IT-`). Opcional.
- **Sufijo** — texto después del número (p. ej. `-HW`). Opcional.
- **Ancho del número** — rellena el número con ceros hasta esta cantidad de dígitos (p. ej. `4` →
  `0042`). Déjalo en blanco para no rellenar.
- **Empezar en** — opcional. Reinicia el contador para que la siguiente etiqueta empiece en este
  número. Déjalo en blanco para continuar la secuencia existente.

Activa el esquema con el interruptor **Asignar etiquetas de activo automáticamente**. Mientras está
activado, cualquier activo nuevo creado sin etiqueta recibe el siguiente número de forma automática.
Mientras está desactivado, no se asigna nada.

> El contador solo avanza **hacia adelante**. Los números pueden tener huecos — eso es esperado y
> correcto. Una etiqueta que escribiste a mano nunca la sobrescribe la asignación automática.

## La garantía de saltar las existentes

Una etiqueta asignada automáticamente **nunca** es una etiqueta que ya existe en un activo vivo. Cuando
el esquema asigna la siguiente etiqueta, salta cualquier número cuya etiqueta ya esté ocupada y usa la
primera libre. Así, si ya existen `IT-1000`, `IT-1002` e `IT-1005`, las siguientes asignaciones
completan `IT-1001`, `IT-1003`, `IT-1004`, `IT-1006`, y así sucesivamente. Nunca se produce una
colisión, aunque arranques el contador dentro de un rango que ya está en uso.

Para ayudarte a elegir un buen punto de partida, el editor sugiere un valor para **Empezar en** basado
en la etiqueta más alta existente que coincide con tu patrón. La sugerencia solo aparece cuando el
esquema está activado y ya hay activos vivos que coinciden con el patrón, y nunca se aplica de forma
automática — haz clic para aceptarla.

## Etiquetar los activos existentes (backfill)

Activar el esquema etiqueta los activos **nuevos** de ahí en adelante; no etiqueta de forma retroactiva
lo que ya tienes. Para etiquetar el parque existente, usa **Etiquetar activos existentes** (visible una
vez activado el esquema). Abre un asistente:

1. **Elige qué etiquetar.** Dos modos:
   - **Solo sin etiqueta** (la opción por defecto y segura) — solo los activos que aún no tienen
     etiqueta reciben una. Las etiquetas existentes no se tocan.
   - **Corregir también las no conformes** (opcional) — además, vuelve a etiquetar los activos cuya
     etiqueta no coincide con el esquema. lazyit muestra primero un aviso explícito, porque esto
     **sobrescribe etiquetas que alguien puso a mano**, que pueden estar impresas en etiquetas físicas.
     Las etiquetas que ya cumplen el esquema nunca se tocan.
2. **Acota el alcance (opcional).** Filtra por un único modelo de activo para hacer el backfill de una
   flota a la vez.
3. **Revisa la vista previa.** Una lista paginada de solo lectura muestra cada activo afectado con su
   etiqueta actual y la etiqueta propuesta. **Todavía no se escribe nada.** Deselecciona las filas que
   quieras omitir — las deselecciones se recuerdan a medida que pasas de página.
4. **Aplica.** lazyit asigna las etiquetas de verdad. Obtienes un resumen de cuántas se etiquetaron y
   cuántas se omitieron.

> El backfill es **solo hacia adelante y auditado** — cada reetiquetado queda registrado en el
> historial del activo. **No hay deshacer masivo.** Si una sola etiqueta sale mal, corrígela editando
> ese activo concreto. Como la vista previa es una proyección (no una reserva), las etiquetas aplicadas
> siguen cumpliendo la garantía de saltar las existentes aunque el parque cambie entre la vista previa
> y la aplicación.

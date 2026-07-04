---
title: Etiquetas de activos
category: assets
subcategory: asset-tags
order: 1
---

# Etiquetas de activos

Una **etiqueta de activo** es la etiqueta de empresa que pegas en un sticker físico — `LZ-0001`,
`IT-2026-0042`. Por defecto escribes cada una a mano. lazyit también puede asignarlas automáticamente
a partir de un número correlativo, para que cada activo nuevo reciba una etiqueta consistente y sin
colisiones. Esto es el **esquema de etiquetas de activos**, configurado en **Configuración →
Instancia**.

> El esquema está **apagado hasta que lo enciendes**. Sin esquema, la creación de activos no cambia:
> la etiqueta de activo es lo que escribes, o nada. Encenderlo es una acción de configuración
> deliberada.

## Cómo el esquema construye una etiqueta

Una etiqueta se arma con tres partes:

- un **prefijo** (opcional, por ejemplo `IT-`),
- un **número** — un contador correlativo, opcionalmente rellenado con ceros hasta un **ancho** fijo
  (ancho 4 → `0042`),
- un **sufijo** (opcional, por ejemplo `-HW`).

Así, un prefijo `IT-` con ancho 4 produce `IT-0001`, `IT-0002`, y así sucesivamente. El editor muestra
una vista previa en vivo de la **Próxima etiqueta** a medida que escribes, para que veas exactamente
qué recibirá el próximo activo.

## Encenderlo

Abre **Configuración → Instancia → Esquema de etiquetas de activos** y activa **Asignar etiquetas
automáticamente**. Fija el prefijo, el sufijo y el ancho de número que quieras, opcionalmente un número
en **Empezar en** para sembrar el contador, y luego **Guardar esquema**. Configurar el esquema requiere
el permiso de *gestionar configuración*.

A partir de ahí, cuando creas un activo y dejas vacío el campo **Etiqueta de activo**, lazyit completa
la próxima etiqueta automáticamente — el formulario de creación incluso sugiere el próximo valor en el
campo. Si **escribes** una etiqueta, tu valor explícito siempre prevalece; el esquema solo cubre el
hueco.

## La regla de saltar las existentes

Una etiqueta asignada automáticamente **nunca** es una que ya existe en un activo vigente. Si el
contador fuera a caer en una etiqueta ya tomada, lazyit salta a la siguiente libre. Por ejemplo, si ya
existen `IT-1000`, `IT-1002` e `IT-1005`, las próximas asignaciones son `IT-1001`, `IT-1003`,
`IT-1004`, `IT-1006`, y así. Esta regla siempre se cumple — no puedes terminar con dos activos
compartiendo una etiqueta.

## La numeración es monótona, no sin huecos

El contador solo avanza. **No** rellena los números que se saltaron, se revirtieron o quedaron libres
al desactivar un activo, así que la secuencia puede tener huecos (`…0041, 0043, 0044…`). Es
intencional: una numeración garantizada consecutiva no compensa la complejidad para un equipo pequeño,
y un número faltante es inofensivo.

## Sugerencia de inicio

Cuando configuras el esquema sobre un parque existente, el editor lee las etiquetas que ya coinciden
con tu patrón y **sugiere un número de inicio** justo por encima de la más alta que encuentra (por
ejemplo "12 etiquetas existentes coinciden — inicio sugerido: 43"). Acepta la sugerencia para que el
contador arranque por encima de tu rango actual, o fija el tuyo.

## Etiquetar activos que ya existen

Encender el esquema **no** etiqueta retroactivamente los activos que ya tienes — solo afecta a los
nuevos. Para etiquetar el parque existente, usa **Etiquetar activos existentes** en la configuración
del esquema. Esto abre una herramienta de revisar y aplicar:

- **Elige qué etiquetar.** *Solo sin etiqueta* (la opción segura por defecto) da etiqueta solo a los
  activos que no tienen ninguna. *También corregir no conformes* además vuelve a etiquetar los activos
  cuya etiqueta no coincide con el esquema — esto va detrás de una advertencia, porque sobrescribe una
  etiqueta puesta a mano que quizás esté impresa. **Las etiquetas conformes nunca se cambian.**
- **Opcionalmente limita a un modelo**, para etiquetar solo un subconjunto.
- **Previsualiza antes de aplicar.** lazyit lista los activos en alcance con su **etiqueta propuesta**,
  sin escribir nada todavía. Deselecciona las filas que quieras omitir.
- **Aplica.** lazyit asigna las etiquetas reales y registra cada una en la actividad del activo.

El reetiquetado masivo es **solo hacia adelante — no hay deshacer masivo.** Si una etiqueta sale mal,
corrígela editando ese único activo.

## Imprimir una etiqueta QR

Cada activo puede imprimir una pequeña **etiqueta QR** para pegar en la unidad física. En la página del
activo, usa **Imprimir etiqueta**. lazyit abre una hoja limpia y sin distracciones que muestra un código
QR con la etiqueta de activo y el nombre impresos debajo, y un botón **Imprimir** que abre el diálogo de
impresión de tu navegador — envíala a una impresora de etiquetas, o imprímela en papel y recórtala.

El QR codifica un **enlace directo a ese activo en lazyit** (construido a partir de la dirección que
estás usando en este momento), así que escanearlo — con el escáner integrado que se describe abajo, o
con la cámara de cualquier teléfono — abre la página del activo. La etiqueta de activo legible siempre se
imprime debajo del código, para que una persona aún pueda leerla o escribirla si no puede escanear.

## Escanear para encontrar un activo

**Activos → Escanear** abre la cámara del dispositivo para leer la etiqueta QR de un activo sin usar las
manos. Apunta la cámara a la etiqueta y lazyit actúa según lo que lee:

- una etiqueta QR de lazyit → abre directamente la página de ese activo;
- cualquier otro código o texto → ejecuta una **búsqueda** de activos con ese valor, para que una
  etiqueta de texto simple también encuentre la unidad.

El escaneo funciona en el navegador — sin instalar ninguna app — en Safari móvil (iOS), Android Chrome y
Firefox de escritorio. Requiere **permiso de cámara** y una **conexión segura (HTTPS)**; permite la
cámara cuando el navegador lo solicite. Si la cámara no está disponible o deniegas el acceso, la misma
pantalla ofrece un campo de **entrada manual** — escribe una etiqueta de activo y ejecuta la misma
búsqueda.

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — dónde aparecen las etiquetas de activo en cada
  unidad.
- [Asignaciones e historial](/help/assets-assignments-history) — el registro de actividad que anota
  cada reetiquetado.

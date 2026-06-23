---
title: Conceptos de activos
category: assets
subcategory: asset-basics
order: 1
---

# Conceptos de activos

Un **activo** es una cosa concreta que tu equipo posee y de la que es responsable: una notebook, un
servidor, un switch, un monitor, una licencia. En lazyit el activo es el registro principal: las
personas cambian, pero el activo permanece y su historial completo viaja con él. Los activos se
gestionan desde la sección **Activos**.

## Registrar un activo

Abre **Activos** y elige **Nuevo activo**. El formulario captura:

- **Nombre** — obligatorio, tu propia etiqueta para la unidad (por ejemplo `Notebook de Ada` o
  `SW-CORE-01`). lazyit no impone una convención de nombres; elige la que le convenga a tu equipo.
- **Estado** — obligatorio (más abajo).
- **Modelo** — opcional. Vincula el activo a un [modelo de activo](/help/assets-models-categories) (su
  marca/modelo). Elegir un modelo puede precargar campos personalizados a partir de los valores por
  defecto del modelo.
- **Ubicación** — opcional. Dónde reside físicamente la unidad. Ver
  [Ubicaciones](/help/assets-locations).
- **Serie** y **Etiqueta de activo** — ambas opcionales (ver *Serie y etiqueta de activo* abajo).
- **Fecha de compra** y **Fin de garantía** — fechas opcionales.
- **Notas** y **Campos personalizados** — detalle libre opcional.

Aquí no asignas un responsable. La asignación es un paso aparte que haces una vez que el activo
existe — ver [Asignaciones e historial](/help/assets-assignments-history).

## Estado

Cada activo se **clasifica con un estado** — no hay valor por defecto, así que eliges uno al
registrarlo. Los valores son:

- **Operativo** — en servicio activo.
- **En mantenimiento** — fuera de servicio temporalmente por reparación o mantenimiento.
- **En depósito** — guardado en stock, sin uso actual.
- **Retirado** — dado de baja, conservado para el registro.
- **Perdido** — sin ubicar.
- **Desconocido** — estado no establecido.

El estado aparece como una etiqueta de color en la lista y en la página de detalle. Cambiarlo queda
registrado en la actividad del activo. También puedes fijar el estado de varios activos a la vez desde
la lista.

## Serie y etiqueta de activo

Son dos cosas distintas, y ambas son opcionales:

- **Serie** — el número de serie de fábrica de la unidad física.
- **Etiqueta de activo** — tu propia etiqueta de empresa, la que pegas en el sticker (por ejemplo
  `LZ-0001`).

Cada una es **única entre los activos activos** cuando se completa: si intentas guardar una serie o
etiqueta que otro activo vigente ya usa, lazyit la rechaza. Cuando un activo se desactiva, su serie y
su etiqueta quedan libres, de modo que el valor puede reutilizarse o restaurarse más adelante.

La etiqueta de activo **no** es la identidad interna del activo — lazyit guarda un identificador
interno, permanente y aparte, para enlaces y referencias. La etiqueta de activo es una etiqueta
visible que puedes cambiar en cualquier momento. Si quieres que lazyit asigne etiquetas
automáticamente a partir de un número correlativo, ver [Etiquetas de activos](/help/assets-asset-tags).

## Campos personalizados

Distintos tipos de activo tienen distintos atributos — una notebook tiene RAM y CPU, un switch tiene
una cantidad de puertos y una IP. En lugar de imponer un conjunto fijo de columnas, lazyit los guarda
como **campos personalizados**: una lista libre de pares nombre/valor en el activo (por ejemplo `ram`
→ `16GB`, `ip` → `10.0.0.4`).

Agrega, edita o quita filas en la sección **Campos personalizados** del formulario. Cuando eliges un
modelo con valores por defecto, esos valores se copian como punto de partida — puedes cambiarlos para
esta unidad concreta antes de guardar. Los campos personalizados se muestran como una lista ordenada
de etiqueta/valor en la página de detalle.

## Encontrar activos en la lista

La lista de **Activos** tiene un buscador y un desplegable de **Estado** en la barra de
herramientas, y además un botón **Filtros** que abre un panel con el resto:

- **Categoría** y **Ubicación** — acota a una categoría de modelo o a un lugar.
- **Responsable** — muestra solo los activos asignados actualmente a una persona concreta. Empieza a
  escribir un nombre para elegirla; la lista mostrará únicamente las asignaciones vigentes de esa
  persona.
- **Responsabilidad** — filtra según si el activo tiene algún responsable actual (*Con responsables*
  / *Sin responsables*), sin importar quién.

El botón **Filtros** muestra un pequeño contador de cuántos de estos están activos. Cada filtro que
aplicas aparece también como una etiqueta que puedes quitar debajo de la barra, y los filtros viven
en la dirección de la página, así que una vista filtrada es fácil de deshacer, compartir o guardar
en marcadores.

### Elegir qué columnas mostrar

El botón **Columnas** (junto a *Filtros*) abre una lista de las columnas de la tabla — etiqueta,
modelo, categoría, ubicación, estado, responsables y actualizado. Desmarca las que no te interesan
para reducir la tabla a lo que te importa. La columna **Nombre** y las acciones de fila siempre se
mantienen. Tu elección se recuerda en este navegador, así que la tabla conserva la misma forma la
próxima vez que entres. (Esto rige la tabla de escritorio; la vista de tarjetas en móvil siempre
muestra el conjunto completo.)

## Editar, clonar y desactivar

- **Editar** actualiza el activo en su lugar; cada cambio relevante (estado, ubicación, modelo, campos
  personalizados) se escribe en la actividad.
- **Clonar** abre un nuevo activo precargado a partir de este, con la serie y la etiqueta de activo
  vacías para que la copia tenga las suyas — útil para registrar un lote de unidades idénticas.
- **Desactivar** un activo es un borrado lógico: el registro se oculta de la lista normal pero nunca se
  destruye, así su historial se conserva. Un administrador puede **restaurar** los activos desactivados,
  lo que además recupera la serie y la etiqueta liberadas (salvo que un activo vigente haya tomado el
  valor mientras tanto). lazyit nunca borra datos de activos de forma definitiva.

## Qué sigue

- [Modelos y categorías](/help/assets-models-categories) — agrupa y clasifica tus activos.
- [Ubicaciones](/help/assets-locations) — controla dónde residen las cosas.
- [Asignaciones e historial](/help/assets-assignments-history) — registra quién tiene un activo a lo
  largo del tiempo.
- [Etiquetas de activos](/help/assets-asset-tags) — asigna etiquetas correlativas automáticamente.

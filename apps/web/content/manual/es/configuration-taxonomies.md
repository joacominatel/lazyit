---
title: Taxonomías
category: configuration
subcategory: taxonomies
order: 2
---

# Taxonomías

Las **taxonomías** son los vocabularios controlados que clasifican tus registros. En lugar de permitir
que cualquiera escriba una categoría en texto libre, lazyit mantiene una lista curada por tipo de
registro, de modo que lo mismo siempre se llame igual — lo que mantiene consistentes el filtrado, los
informes y la búsqueda. Se gestionan todas desde **Configuración → Taxonomías** (solo administradores).

## Qué puedes gestionar

La pantalla de Taxonomías tiene dos paneles. A la izquierda aparece cada taxonomía agrupada por módulo,
con cuántas entradas tiene; elige una y se abre a la derecha. (En el teléfono, la lista es un selector
arriba.)

- **Activos**
  - **Categorías** — cómo se agrupan los activos (p. ej. portátiles, monitores, teléfonos).
  - **Modelos** — los registros de marca/modelo que los activos referencian (p. ej. *Dell Latitude
    5440*). Un modelo reúne los datos compartidos, así cada activo solo guarda lo que es propio de esa
    unidad.
  - **Estados personalizados** — los nombres propios de tu equipo para los estados de activo
    predefinidos (consulta [Estados de activo personalizados](#estados-de-activo-personalizados) más
    abajo). Opcional.
- **Aplicaciones → Categorías** — cómo se agrupan las aplicaciones.
- **Consumibles → Categorías** — cómo se agrupan los consumibles.
- **Conocimiento → Carpetas** — un enlace a la base de conocimiento. Los artículos se archivan en
  **carpetas**, y las creas, renombras y ordenas en la propia base de conocimiento, no aquí. Consulta
  [Carpetas y acceso](/help/knowledge-base-folders-access).

Cada entrada es una fila compacta: su **nombre**, su descripción en gris cuando la tiene, cuánto está
**en uso** — *42 activos*, *5 apps*, *3 consumibles* o *Sin uso* — y un menú **⋯**. En una categoría, el
recuento es cuántos registros **perderán su categoría** si la eliminas. (Justo después de una
actualización, antes de que el servidor informe los recuentos, la columna queda vacía en lugar de
adivinar.)

- **Agregar** — escribe un nombre en la fila **Nueva categoría…** al final de una lista de categorías y
  pulsa **Agregar** (o Intro). Los modelos y los estados personalizados tienen más campos, así que
  conservan un botón **Nuevo** que abre su formulario completo.
- **Editar** — **⋯ → Editar** abre el formulario completo: nombre, descripción, icono, orden y, en las
  categorías de activo, el [diccionario de especificaciones](/help/assets-models-categories).
- **Duplicar** — **⋯ → Duplicar** abre una entrada nueva rellenada a partir de esta.
- **Eliminar** (categorías, modelos) o **Archivar** (estados personalizados) — desde el mismo menú, con
  una confirmación.
- **Filtrar** — el cuadro de filtro sobre cada lista la acota por nombre o descripción.

**Qué hace eliminar una categoría.** Eliminar una categoría de activos, aplicaciones o consumibles es
un **borrado lógico**: la categoría se oculta, nunca se borra, y se puede restaurar. lazyit **no** te
impide eliminar una categoría que está en uso. Los registros archivados en ella conservan todos sus
datos, pero se muestran **sin categoría** hasta que se restaure la categoría o los clasifiques en otra.
La confirmación dice cuántos registros son (*La usan 42 activos — conservan sus registros, pero se
muestran sin categoría hasta que se restaure*). Todavía no hay una lista de categorías eliminadas en
Configuración; un administrador puede restaurar una a través de la API
(`POST /api/asset-categories/{id}/restore`, y lo mismo en `application-categories` y
`consumable-categories`).

**Eliminar varias categorías a la vez.** Elige **Seleccionar** sobre la lista para mostrar una casilla
en cada fila, marca las que quieras quitar y usa **Eliminar** en la barra de selección. La
confirmación nombra las categorías seleccionadas que están en uso y cuántos registros se mostrarán sin
categoría en total. lazyit las elimina una por una e informa el resultado; si una petición falla (por
ejemplo, se corta la conexión), esa fila queda seleccionada y el resumen dice cuántas no se pudieron
eliminar, para que vuelvas a intentarlo. **Listo** sale de la selección. (El borrado masivo requiere el permiso de eliminación de
categorías; **Seleccionar** solo aparece si lo tienes.)

Los enlaces antiguos que abrían una pestaña — `?tab=asset`, `?tab=models`, `?tab=statuses`, etc. —
siguen abriendo la misma taxonomía. Un enlace a la antigua pestaña *Categorías de artículo* ahora
muestra dónde gestionar las carpetas.

## Estados de activo personalizados

Cada activo tiene uno de seis **estados predefinidos**: Operativo, En mantenimiento, En depósito,
Retirado, Perdido y Desconocido (consulta [Estado](/help/assets-asset-basics#estado)). Son fijos, y son
los que leen el panel, los filtros, las importaciones, los informes y todas las demás reglas. Los
**estados personalizados** permiten que tu equipo use sus propias palabras encima de ellos: *En
reparación en el proveedor* y *En el banco de trabajo* pueden ser dos formas de *En mantenimiento*;
*Pool de préstamo* y *Esperando imagen* pueden ser dos formas de *En depósito*.

Son **opcionales**. Si nunca creas uno, nada cambia: los activos siguen usando los estados
predefinidos como siempre, e incluso cuando ya tengas algunos, cualquier activo puede quedarse con un
estado predefinido sin nombre propio.

**Cómo se corresponden.** Cada estado personalizado pertenece a **un único** estado predefinido. Darle
a un activo un estado personalizado también fija su estado predefinido en ese — así, un activo en
*Pool de préstamo* cuenta como *En depósito* en todos los lugares donde importa el estado predefinido
(el gráfico del panel, el filtro **En depósito**, los informes). La lista **Estados personalizados**
muestra esta correspondencia directamente: los seis estados predefinidos son encabezados de grupo fijos, y tus
estados personalizados aparecen bajo el que corresponde a cada uno.

**Crear y editar.** Usa **Nuevo estado personalizado**, o **Agregar** en el encabezado de un estado
predefinido para empezar dentro de él. Un estado personalizado tiene:

- **Nombre** — obligatorio, único entre los estados personalizados vigentes.
- **Estado predefinido** — aquel del que es una forma.
- **Color** — opcional. Elige uno de la paleta o escribe un valor `#RRGGBB`; colorea el punto junto al
  nombre. Si lo dejas vacío, el punto usa el color del estado predefinido.
- **Descripción** y **Orden** — opcionales. El orden ordena los estados personalizados dentro de su
  estado predefinido (los menores primero).

Cada estado personalizado muestra cuántos activos lo usan; haz clic en el recuento para abrir la lista
de Activos filtrada por él.

**El estado predefinido queda bloqueado mientras está en uso.** No puedes pasar un estado
personalizado a otro estado predefinido mientras algún activo lo use — esos activos cambiarían de
estado sin avisar. El campo aparece deshabilitado e indica cuántos activos lo usan. Mueve primero esos
activos a otro estado, o crea un estado personalizado nuevo.

**Archivar uno que está en uso pregunta a dónde van sus activos.** Cuando archivas un estado
personalizado que todavía usan algunos activos, lazyit te pide elegir un destino — otro estado
personalizado o un estado predefinido — y te dice cuántos activos se moverán. El movimiento y el
archivado ocurren juntos, y cada activo movido recibe una entrada en su historial. Un estado
personalizado que ningún activo usa se archiva con una confirmación simple.

Los **estados archivados** aparecen con **Mostrar archivados** (administradores), donde puedes
**Restaurar** uno. Un estado personalizado restaurado vuelve sin activos — se movieron al archivarlo.

Gestionar estados personalizados usa los mismos permisos que las categorías: verlos requiere el
permiso de ver categorías, crearlos y editarlos el de editar categorías, y archivarlos o restaurarlos
el de eliminar categorías.

## Cómo se relacionan las taxonomías con los registros

Una categoría o un modelo es una **referencia** a la que apuntan los registros — no es el registro en
sí. Un activo *pertenece a* una categoría de activo y *es un* modelo; no posee una copia privada de
ninguno. Por eso importa mantener la lista curada: renombra una categoría una vez y todos los registros
que la referencian lo reflejan.

Quitar una entrada de taxonomía sigue las mismas reglas de **borrado lógico y auditoría** que el resto
del dominio: la entrada se oculta, no se borra, y los registros que la referencian se conservan. Un
registro cuya categoría se eliminó simplemente se muestra sin ella. Revisa el recuento **En uso** antes
de eliminar, y clasifica primero los registros en otra entrada si deben conservar una.

## Dónde gestionar la configuración relacionada

- **Ubicaciones** son un registro hermano, accesible desde la navegación de Configuración y no desde
  Taxonomías — describen *dónde* están los activos, no *de qué tipo* son.
- **Categorías frente a modelos de activo** — las categorías son cubos amplios para agrupar y filtrar;
  los modelos son definiciones concretas de marca/modelo. Usa las categorías para segmentar tu parque,
  y los modelos para no volver a escribir los mismos datos de hardware en cada unidad.

Para ver cómo los modelos y las categorías impulsan la experiencia de activos, consulta la sección
Activos de este manual.

## Con el asistente de IA

Si el [asistente de IA](/help/ai-assistant-overview) está activado, también puedes pedirle que cree,
renombre o edite categorías de activos, aplicaciones y consumibles, que archive una, que edite, archive o
restaure modelos de activo y ubicaciones, y que cree, edite, archive o restaure estados de activo
personalizados. Cada cambio se propone como una tarjeta que apruebas, y una
tarjeta de archivado indica qué sigue usando la entrada antes de que decidas. Consulta
[Aprobar cambios](/help/ai-assistant-approvals#categorías-modelos-y-ubicaciones).

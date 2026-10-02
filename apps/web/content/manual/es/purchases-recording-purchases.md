---
title: Compras y proveedores
category: purchases
subcategory: recording-purchases
order: 1
---

# Compras y proveedores

**Compras** guarda el lado de IT de lo que compra tu equipo: a qué proveedor se le compró, el número de
orden de finanzas, las facturas, las líneas y los precios, y cuántas de las unidades llegaron. Responde
preguntas como "¿qué activos están en la factura X?" o "¿llegó por fin la cuarta notebook de esa orden?".

lazyit **registra** compras; no gestiona el proceso de compra. Tu sistema de finanzas sigue siendo el
sistema de registro — aquí no hay aprobaciones, presupuestos, pagos ni cotizaciones.

## Es opcional

Nada en lazyit exige una compra. Un activo nunca la necesita, y los campos de compra del activo (fecha,
costo, moneda, garantía) siguen funcionando igual que antes, uses Compras o no. Si tu equipo nunca
registra una compra, el área simplemente queda vacía.

La encuentras en la barra lateral en **Inventario → Compras**, con tres pestañas: **Compras**, **Unidades
pendientes** y **Proveedores**.

## Quién puede verla

Compras tiene sus propios permisos, separados de los de inventario:

| Capacidad | Administrador | Miembro | Lector |
| --- | :---: | :---: | :---: |
| **Ver compras y proveedores** | Sí | Sí | No |
| **Registrar y editar compras** (compras, líneas y proveedores) | Sí | Sí | No |
| **Eliminar compras y proveedores** (archivar y restaurar) | Sí | No | No |

**El Lector no tiene acceso por defecto**, porque las compras llevan precios y proveedores. Un
administrador puede concederlo desde la pantalla de permisos de roles (ver [Permisos](/help/permissions))
— pero los permisos son de un **rol**, no de una persona: concederlo al Lector se lo concede a **todos**
los lectores. Un lector sin ese permiso sigue viendo los campos de costo propios del activo, como antes,
pero no el panel **Compra** del activo (más abajo).

Recibir unidades y vincular o desvincular activos también crea o cambia activos, así que necesitan
**Registrar y editar compras** *y* el permiso para crear y editar activos. Recibir una línea de
consumible en stock cambia el stock, así que necesita **Registrar y editar compras** *y* el permiso para
editar consumibles.

## Registrar una compra

Elige **Nueva compra**. El formulario está pensado para ser rápido: solo hace falta lo que identifica la
compra — **un proveedor, una referencia o una línea**. Todo lo demás es opcional y se puede completar
después.

- **Proveedor** — escribe el nombre. Mientras escribes se sugieren los proveedores que ya usaste, y si
  lo que escribiste es solo otra forma de escribir uno existente (`COMPUMUNDO SA` por `Compumundo`), una
  pista te ofrece el existente. Un nombre que nadie usó todavía crea el proveedor al guardar — el campo
  te lo indica. Si varios proveedores tienen exactamente ese nombre, eliges cuál.
- **Referencia** — el número de orden de compra de finanzas. Es como se llama la compra en todas
  partes, y mientras escribes sugiere las referencias que ya se usaron. Sin ella, la compra se lee como *Proveedor · fecha*, o *Compra · fecha* cuando tampoco tiene
  proveedor. Las referencias no son únicas: si el proveedor ya tiene una compra con la misma referencia,
  una pista la enlaza, y igual puedes guardar.
- **Fecha de pedido** y **Estado** — *Pedida* (por defecto) o *Borrador*.
- **Moneda** — ver más abajo.
- **Más detalles** — entrega prevista, dónde se entrega, empresa, números de factura (un solo campo,
  con tantos como necesites — sugeridos a partir de los ya usados), fecha de factura y notas.

### Líneas

Cada línea es algo que compraste. Una línea solo necesita una **descripción** — como figura en el
presupuesto o la factura; se sugieren las descripciones que ya escribiste, para que el mismo ítem se
escriba siempre igual. Su **cantidad** es 1 por defecto y el **precio unitario** es opcional (en
blanco significa desconocido; `0` significa sin cargo). El precio unitario suele ir sin IVA.

Hay tres tipos de línea:

- **Activo** — hardware que vas a registrar como activos. Puedes anotar la **marca** y el **modelo como
  figura** en el documento, asignarla a un **modelo de activo** si ya lo tienes (no es obligatorio — se
  puede asignar después) y registrar la **garantía** en meses.
- **Consumible** — tóner, cables, pilas: unidades que entran al stock de un
  [consumible](/help/consumables-consumables-categories) en lugar de convertirse en activos. Puedes elegir
  ahora el **consumible** al que entran, o dejarlo para cuando lleguen.
- **Otro** — flete, un servicio, una bonificación. Cuenta en el total pero nunca espera una entrega.

El teclado hace casi todo: **Enter** en una línea agrega la siguiente, y **Ctrl+Enter** (**⌘+Enter** en
Mac) guarda la compra. El total acumulado se muestra debajo de las líneas.

Una vez guardada, las líneas se editan, agregan y quitan en la página de la compra. Una línea solo se
puede quitar mientras no se haya recibido ningún activo en ella.

## La moneda es una etiqueta

La **moneda** de una compra es una etiqueta de texto libre — `ARS`, `USD`, `u$s`, `pesos`, lo que
escriba tu equipo. lazyit no le da ningún significado: nunca convierte, nunca busca cotizaciones y nunca
cambia cómo se muestra un número. Dice en qué están los importes, nada más. El campo empieza con la
etiqueta que usaste por última vez y sugiere las que ya están en uso.

Por eso los totales se **agrupan por etiqueta y nunca se suman entre etiquetas**: una lista o un total
muestra un importe por moneda. Las etiquetas se comparan sin importar mayúsculas ni los espacios al principio o al
final, así que `usd` y `USD ` son el mismo grupo — pero `USD` y `u$s` son dos. Una compra sin etiqueta muestra sus
importes como **Sin moneda**, nunca como una moneda por defecto.

Los importes se escriben y se muestran con el formato de números de tu idioma — ver
[Escribir importes](/help/assets-asset-basics#escribir-importes).

## Estado y entrega

El estado lo fijas tú: **Borrador**, **Pedida** o **Cancelada**. Lo que llegó se calcula a partir de los
activos vinculados a cada línea — y, en una línea de consumible, del stock recibido en ella —, así que una compra pedida también se lee sola como **Recibida
parcialmente** o **Recibida**, y cada línea muestra **"3 de 4 recibidas"**, con las unidades pendientes o
canceladas.

- Una línea puede terminar con **más** unidades de las pedidas. Está permitido — se muestra como
  **Recibida de más**, como un aviso para revisar, nunca como un error.
- **Cancelar compra** (en el menú *Estado*) solo se ofrece mientras no se haya recibido nada. Una compra
  cancelada se puede volver a marcar como pedida.

La lista de **Compras** se abre en las compras que todavía **esperan unidades**; cambia el filtro para
verlas todas, o filtra por estado o proveedor, y busca por referencia, número de factura, proveedor o
ítem.

## Recibir unidades

Cuando llegan las cajas, abre la compra y elige **Recibir** en la línea (o **Recibir unidades** en el menú
de la línea). Es el mismo formulario de [Recibir stock](/help/assets-bulk-receiving), ya completado desde
la compra, así que normalmente lo único que hay que escribir son los **números de serie**:

- Los **números de serie** van primero — pega o escribe uno por línea. La **cantidad sigue a los números
  de serie**; con el cuadro vacío empieza en todas las unidades pendientes, y puedes escribir un número
  para recibir unidades sin número de serie.
- **Desde la compra** muestra lo que recibe cada unidad: el modelo de la línea, el estado *En depósito*,
  la empresa de la compra, el costo por unidad **con la etiqueta de moneda de la compra**, la fecha de
  compra y el fin de garantía. Elige **Cambiar** para editar cualquiera de ellos solo para esta recepción.
- La **fecha de compra** es la **fecha de factura** de la compra, u **hoy** cuando todavía no tiene —
  nunca la fecha de pedido. El **fin de garantía** es esa fecha más los meses de garantía de la línea.
- Las unidades quedan donde se **entrega** la compra, y los documentos de la compra se ven en cada una.
- **Escanear**, junto a los números de serie, los lee con la cámara — ver
  [Escanear números de serie](#escanear-números-de-serie).

Si la línea **no tiene modelo** todavía, el formulario te pide uno (puedes crearlo ahí mismo). El modelo
que elijas se guarda en la línea, así la próxima entrega ya lo tiene.

Cada unidad se crea por separado, así que una recepción puede salir **en parte** — el resultado lista
cada unidad que no se pudo crear y por qué, igual que en Recibir stock. Los activos nuevos quedan
**vinculados a la línea** y cuentan como recibidos al instante.

También puedes empezar desde el otro lado: en **Recibir stock** y en **Nuevo activo**, un selector
opcional **Desde una compra** lista las líneas que todavía esperan unidades, y cuando eliges un modelo
que una compra está esperando, una pista discreta te ofrece **recibir contra ella**.

### Recibir más de lo pedido

Recibir (o vincular) más unidades de las que una línea todavía espera **está permitido**. El formulario
te avisa antes — "esta línea espera 4 y quedaría con 5" — y ofrece **Subir la línea a 5**, que cambia la
cantidad de la línea (queda en el registro de actividad). También puedes seguir sin hacerlo: la línea se
muestra entonces como **Recibida de más**.

### Escanear números de serie

En la puerta del depósito, con el teléfono, **Escanear** junto a los números de serie abre la cámara en
el mismo formulario. Apúntala al código de barras del número de serie de cada caja — se leen los códigos
de barras habituales Code 128 y Code 39, EAN/UPC y códigos QR — y cada código nuevo se agrega en su propia
línea con una pequeña señal (y una vibración en los teléfonos que la tienen). Un código que ya está en la
lista no se agrega dos veces; te lo avisa. Elige **Listo** para cerrar la cámara; la lista sigue siendo
editable, así que puedes corregir o quitar una línea a mano.

La cámara necesita el permiso del navegador y una conexión segura (HTTPS). Sin cámara, o si niegas el
acceso, el formulario lo dice y escribes o pegas los números de serie como siempre.

## Recibir en stock

Una línea de **consumible** se recibe en el stock de su consumible, no como activos. Elige **Recibir** en la
línea (o **Recibir en stock** en su menú, o **Recibir** en *Unidades pendientes*):

- **Cantidad recibida** empieza en las unidades todavía pendientes. Escribe lo que llegó de verdad —
  recibir más de lo pendiente está permitido, con el mismo aviso y la misma opción de **Subir la línea**
  que con los activos.
- Si la línea **no tiene consumible** todavía, el formulario te pide uno; se guarda en la línea, así la
  próxima entrega ya lo tiene.
- La **nota** es opcional. Se guarda en el movimiento de stock del consumible, y **cualquiera que pueda ver
  los movimientos de ese consumible puede leerla — incluidos los Lectores** —, así que no pongas ahí datos
  de la factura ni del proveedor.

Recibir registra un movimiento de **Entrada** en el consumible (su stock sube, como con cualquier
[movimiento de stock](/help/consumables-stock-movements)) y la línea cuenta las unidades como recibidas.
Una recepción de stock no se puede deshacer desde la compra: si recibiste de más, corrige el stock con un
movimiento normal en el consumible — la línea sigue contando lo que se recibió. Por lo mismo, una línea de
consumible que ya recibió stock no puede cambiar de tipo ni quitarse.

## Vincular activos que ya tienes

Los activos comprados antes de que empezaras a registrar compras — o cargados a mano — se pueden vincular
a su línea de compra después. Hay tres caminos:

- En la compra, **Vincular activos existentes** en el menú de una línea: busca y marca los activos. La
  lista empieza filtrada por el modelo de la línea y por activos **sin compra vinculada**; quita una
  etiqueta para ampliarla (un activo que ya está en otra compra igual se puede mover aquí, ver más abajo).
- En un activo sin vincular, **Vincular a una compra** en su panel **Compra**.
- En la lista de **Activos**, selecciona varias filas y elige **Vincular a una compra** en la barra de
  selección. Luego elige la compra y la línea — las líneas del mismo modelo aparecen primero.

### Elegir qué valores copiar

Antes de vincular nada, lazyit compara cada activo con la compra, **campo por campo**: costo de compra
(con su moneda), fecha de compra, fin de garantía, empresa y modelo. Los valores propios del activo
siguen mandando — un valor de la compra llega a un activo **solo donde lo marques**:

- Un campo **vacío** que la compra puede completar viene **marcado** (*Completar*).
- Un campo que **reemplazaría** un valor distinto **nunca** viene marcado (*Reemplazar*). El interruptor
  **Aplicar todos los valores de la compra** los marca todos de una vez.
- **El costo y la moneda van juntos**: reemplazar el costo también pone su etiqueta de moneda.
- Los campos iguales, o para los que la compra no tiene valor, no tienen nada que aplicar.

La comparación se agrupa por campo, así que vincular veinte monitores son cinco decisiones, no cien.
**Ver cada activo** abre la grilla por activo para el caso raro en que los activos necesitan elecciones
distintas. La línea bajo la tabla repite lo que va a pasar — "4 activos vinculados · 3 valores
completados · nada reemplazado" — antes de confirmar.

La fecha de compra que se ofrece es la fecha de factura de la compra, o su fecha de pedido cuando no hay
fecha de factura. El proveedor, la compra y sus documentos siempre quedan vinculados; no hay nada que
aplicar para ellos.

### Activos que ya están en una compra

Un activo solo puede pertenecer a una línea de compra. Los activos que ya están en **esta** línea
simplemente se omiten. Los que están en **otra** compra se listan aparte y **nunca se mueven sin avisar**:
marca **Mover aquí** en cada uno que en realidad pertenece a esta línea.

Si algunos activos no se pueden vincular — por ejemplo, uno se archivó mientras tanto — los demás se
vinculan igual, y el resultado lista cada uno que no, con el motivo.

### Desvincular

**Desvincular de la compra** en el panel **Compra** del activo quita el vínculo. El activo **conserva sus
valores de compra** — desvincular nunca borra nada — y tanto el historial del activo como el registro de
actividad de la compra lo registran.

También puedes desvincular desde la compra: en una línea que ya recibió unidades, **Ver activos** bajo su
"x de y recibidas" lista los activos vinculados, cada uno con un enlace a su página y **Desvincular**. La
lista se carga solo cuando la abres, y muestra los primeros 50 activos de una línea.

## Cancelar las unidades restantes

Cuando el resto de una línea no va a llegar, elige **Cancelar unidades restantes** en el menú de la
línea. Cancela todas las unidades pendientes por defecto (puedes cancelar menos) y acepta un **motivo**
opcional, que queda en el registro de actividad. La línea pasa a leerse, por ejemplo, "3 de 4 recibidas ·
1 cancelada", deja de esperar unidades y sale de *Unidades pendientes*; si era la última línea pendiente,
la compra se lee como **Recibida**.

## Unidades pendientes

La pestaña **Unidades pendientes** lista cada línea que todavía espera unidades, **agrupadas por compra,
el pedido más antiguo primero** — la revisión semanal, y la pantalla para abrir en la puerta del depósito.
Las compras en borrador y canceladas, las líneas *Otro* y las líneas cuyo resto se canceló no aparecen.
Se puede filtrar por proveedor.

Cada línea muestra "x de y recibidas" y lo que sigue pendiente, con **Recibir** y, en su menú, **Vincular
activos existentes** y **Cancelar unidades restantes**. En una línea de consumible, **Recibir** abre
[Recibir en stock](#recibir-en-stock), y no hay nada que vincular. Una compra cuya **entrega prevista** ya pasó se
marca como **Atrasada**.

## Documentos

Una compra guarda sus **documentos** — el presupuesto, la orden, las facturas, una foto del remito — en la
sección **Documentos** de su página. Súbelos con el botón o arrastrando archivos sobre la sección; rigen
los mismos tipos de archivo y el mismo límite de tamaño que los
[documentos de activos](/help/assets-asset-basics#documentos). Cualquiera que pueda ver compras puede
descargarlos; subir y borrar necesita **Registrar y editar compras**. Agregar o quitar un documento queda
en el registro de actividad.

Cada documento puede llevar un **tipo** opcional — *Presupuesto*, *Factura*, *Remito*, lo que escriba tu
equipo. Se sugieren los tipos ya usados mientras escribes, y ninguno es obligatorio. Completa **Tipo**
antes de subir para ponerlo en los archivos de esa subida, o usa el lápiz de un documento para ponerlo,
cambiarlo o quitarlo después (vacía el campo para quitarlo). El tipo se ve junto al nombre del archivo,
aquí y en cada activo vinculado; cambiarlo queda en el registro de actividad.

Los documentos se **comparten, no se copian**: cada activo vinculado a la compra lista los mismos
archivos en su panel **Compra**.

> **Copias de seguridad.** Los archivos subidos se guardan en el volumen de archivos del servidor, que
> **todavía no está cubierto por la copia de seguridad de la base de datos** — la sección Documentos
> también lo dice. Hasta que llegue esa copia, guarda tu propia copia de cada factura, orden o remito que
> necesites conservar.

## El panel Compra del activo

Un activo vinculado a una compra muestra un panel **Compra** en su página, justo después de *Detalles*:
la compra (con un enlace), el proveedor, la línea y su "x de y recibidas", la referencia, las fechas de
pedido y de factura, los números de factura, la moneda, el precio en la compra, el **contacto de soporte**
del proveedor — útil para un reclamo de garantía — y los documentos de la compra, listos para descargar.

- **Solo lo ven quienes pueden ver compras.** Sin ese permiso el panel no se muestra; el costo, la moneda
  y las fechas propios del activo siguen visibles en *Detalles*, como antes.
- **Distinto de la compra** marca el precio cuando el costo de compra propio del activo es distinto —
  otro importe u otra etiqueta de moneda. Solo se compara el costo: las fechas pueden variar con cada
  entrega. lazyit nunca corrige el costo por su cuenta; edita el activo si debe coincidir.
- Si la compra se **archivó**, el panel sigue diciendo de dónde vino el activo, marcada como archivada y
  sin sus documentos.
- Un activo sin vincular muestra el panel solo a quien puede vincularlo, con **Vincular a una compra**.

## El registro de actividad

Cada compra lleva un registro de **actividad** de solo agregado: quién la registró, quién cambió el
estado, quién agregó, editó o quitó una línea — con un cambio de precio o cantidad mostrado como
*antes → después* —, quién recibió, vinculó, movió o desvinculó unidades, quién recibió stock en una línea
de consumible, quién canceló unidades restantes (con el motivo) y quién agregó o quitó un documento o
cambió su tipo. No se puede editar ni borrar.

## Proveedores

La pestaña **Proveedores** es el directorio de a quién le compras y le pagas. Un proveedor **no** es el
fabricante del hardware (eso está en el modelo de activo) **ni** el fabricante del software (eso está en
la aplicación).

Un proveedor solo necesita un **nombre**. También puede tener un **ID fiscal**, un **sitio web**, un
**contacto comercial** y un **contacto de soporte / RMA** separado — útil cuando surge un reclamo de
garantía — y notas. Su página lista las compras que se le hicieron.

Los nombres y los ID fiscales no son únicos, así que lazyit nunca rechaza un duplicado; en cambio,
sugiere. Escribir un ID fiscal que otro proveedor ya tiene te dice de quién es.

## Archivar

Los administradores pueden **archivar** una compra o un proveedor. Archivar los oculta de las listas sin
borrarlos, cada activo conserva su vínculo, y se pueden restaurar desde la vista de archivados.

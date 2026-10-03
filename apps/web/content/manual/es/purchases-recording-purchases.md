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
editar consumibles. Aplicar una línea de licencia cambia su aplicación, así que necesita **Registrar y
editar compras** *y* el permiso para editar aplicaciones. [Leer un documento con IA](#leer-un-documento-con-ia)
necesita **Registrar y editar compras** *y* el permiso para usar el asistente de IA.

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

Hay cuatro tipos de línea:

- **Activo** — hardware que vas a registrar como activos. Puedes anotar la **marca** y el **modelo como
  figura** en el documento, asignarla a un **modelo de activo** si ya lo tienes (no es obligatorio — se
  puede asignar después) y registrar la **garantía** en meses.
- **Consumible** — tóner, cables, pilas: unidades que entran al stock de un
  [consumible](/help/consumables-consumables-categories) en lugar de convertirse en activos. Puedes elegir
  ahora el **consumible** al que entran, o dejarlo para cuando lleguen.
- **Licencia** — asientos de software: la renovación de una suscripción, más asientos de una aplicación. Su
  cantidad son los **asientos** comprados, y puedes elegir ahora la [aplicación](/help/applications-applications)
  a la que corresponden, o al aplicarlos. Ver [Aplicar una licencia](#aplicar-una-licencia).
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

## Aplicar una licencia

Una línea de **licencia** nunca cambia por sí sola los asientos de su aplicación. Cuando los asientos ya
son tuyos, elige **Aplicar licencia** en la línea (o en *Unidades pendientes*). El formulario lee primero
la aplicación y muestra qué haría aplicarla:

- los **asientos comprados** de la aplicación ahora — y después —, los asientos **en uso** y su **fecha de
  renovación**;
- **Asientos a sumar** empieza con los asientos de la línea que todavía no se aplicaron. Cámbialo si
  llegaron menos, o déjalo vacío para fijar solo la renovación;
- **Nueva fecha de renovación** es opcional y nunca se completa por ti: la compra no dice cuánto dura la
  licencia, así que escríbela cuando esta compra la renueva.

Solo se aplica lo que confirmas, exactamente como si hubieras editado la aplicación. La línea cuenta los
asientos como **aplicados** ("10 de 25 asientos aplicados"), igual que las unidades recibidas.

- Aplicar **más asientos de los que compró la línea** está permitido, con un aviso; la línea muestra
  entonces más asientos que los comprados.
- Una aplicación que **todavía no cuenta asientos** (sin asientos comprados — ilimitada) empieza a
  contarlos desde los que sumas; el formulario lo avisa antes.
- Una línea **sin aplicación** pide una primero, y la guarda en la línea.

Los asientos aplicados no se le quitan a la compra: si aplicaste de más, corrige los asientos en la
aplicación. Por eso mismo, una línea de licencia con asientos aplicados ya no puede cambiar de tipo ni
quitarse.

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

### Crear una compra a partir de activos

Cuando la compra nunca se registró, selecciona los activos en la lista de **Activos** y elige **Crear
compra** en la barra de selección. Un formulario corto pide el **proveedor**, la **referencia** y la
**moneda** — todos opcionales, todos sugeridos mientras escribes. lazyit crea entonces **una compra** con
**una línea por modelo** (los activos sin modelo se agrupan por nombre), con la cantidad de activos de cada
línea, y vincula cada activo a su línea.

- **Solo cambia el vínculo.** No se toca el costo, la fecha ni ningún otro campo de los activos. El precio
  unitario de una línea se completa solo cuando **todos** sus activos tienen el mismo costo en la moneda de
  la compra; si no, queda vacío — nunca un promedio.
- Deja **Moneda** vacía para usar la etiqueta que ya comparten los costos de los activos.
- Los activos archivados, o que ya están en otra compra, **quedan afuera** y se listan con el motivo; la
  compra se crea con los demás. (Para mover un activo desde su compra, usa **Vincular activos
  existentes**.) Si ninguno de los activos seleccionados se puede vincular, no se crea nada.

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
[Recibir en stock](#recibir-en-stock), y no hay nada que vincular. Una línea de licencia ofrece
[Aplicar licencia](#aplicar-una-licencia) en su lugar. Una compra cuya **entrega prevista** ya pasó se
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

## Leer un documento con IA

lazyit puede leer una factura, un presupuesto o un remito y **completar la compra para que la revises**.
Viene **desactivado**: un administrador activa **Extracción de documentos** en
[Configuración → IA](/help/ai-assistant-setup#extracción-de-documentos), y necesita el asistente de IA
activado con un proveedor que lea documentos (Anthropic, OpenAI o Google Gemini).

**Qué se envía.** Cuando alguien lee un documento, el **archivo completo** — con el proveedor, los precios
y los IDs fiscales que muestre — va al proveedor de IA configurado en Configuración → IA, bajo tu contrato
con él. Ningún otro dato de lazyit va con él, ni siquiera el nombre del archivo. Cada lectura cuenta para el
presupuesto diario de IA de esa persona y queda en el registro de actividad de la compra (quién, qué
proveedor y modelo — nunca los valores leídos).

Hay tres formas de empezar:

- En una compra, **Leer este documento** sobre un PDF o una imagen de sus **Documentos** (hasta 10 MB —
  algo menos para imágenes con algunos proveedores — y 20 páginas).
- En **Nueva compra**, **Nueva compra desde un documento**: eliges el archivo, y lazyit crea una compra en
  **borrador** con el nombre del archivo, lo adjunta y lo lee. Guardar la revisión completa la compra y la
  **marca como pedida** (viene marcado — desmárcalo para dejarla en borrador). Si lo dejas antes de guardar,
  el borrador conserva el documento y puedes completarlo a mano.
- En una compra, **Pedirle a la IA que la complete** sobre un documento abre el [asistente de IA](/help/ai-assistant-using-the-chat#completar-una-compra-a-partir-de-un-documento)
  con un mensaje que le pide leer ese documento y completar la compra. Envíalo, responde las pocas
  preguntas que hace y aprueba la tarjeta que propone — no hay pantalla de revisión, y no se guarda nada
  hasta que apruebas. Solo aparece donde está *Leer este documento*, y cuando puedes usar el asistente.

La lectura tarda hasta dos minutos. Si falla, no se completó nada y el documento sigue adjunto: la pantalla
dice por qué (el proveedor estaba ocupado, el archivo tiene demasiadas páginas, se agotó el presupuesto
diario…).

### Revisar el borrador

La revisión muestra el **documento junto al borrador**: una imagen ahí mismo, un PDF como una tarjeta cuyo
**Abrir en una pestaña nueva** lo abre en el visor de tu navegador — pon esa pestaña junto a la revisión. **No
se guarda nada hasta que eliges Guardar**, y entonces solo lo que está marcado:

- **Pasa el puntero o el foco por un valor** para ver qué se leyó y en qué página — `Leído "1.412.500,00" ·
  página 1`. Así se detecta de un vistazo un separador de miles mal puesto.
- **Vacío antes que adivinar.** Un valor que el documento no dice con claridad queda **vacío**, marcado
  **No leído** — nunca se completa con una suposición. Si no se leyó la cantidad de una línea nueva, hay
  que escribirla antes de poder agregarla; un precio desconocido simplemente queda desconocido.
- **Revisar** marca lo que necesita tu atención, y el contador de arriba salta de uno al siguiente:
  - un importe que se lee de dos maneras (`1.150` — ¿mil ciento cincuenta, o uno coma quince?) queda vacío;
    también uno con más de dos decimales;
  - una fecha que puede ser día/mes o mes/día, sin nada en el documento que lo aclare, queda vacía;
  - una moneda que solo aparece como un símbolo que comparten varias monedas (`$`);
  - una línea cuya cantidad × precio unitario no es el total de línea que imprime el documento.
- **Si el guardado se corta a mitad de camino** (una caída de la conexión, un rechazo), lo que ya se guardó
  se conserva y aparece como **Guardado**, bloqueado; **Guardar** escribe entonces solo el resto.
- **El control de totales** compara las líneas, a medida que las corriges, con el neto (o el total) que
  imprime el documento: **Coinciden**, o en cuánto **difieren** — casi siempre una línea sin precio.
- **El proveedor** se busca entre los que ya tienes, por ID fiscal (lo más confiable) o por nombre
  (revísalo). Puedes usar la coincidencia, **crear** el proveedor como figura en el documento (con su ID
  fiscal) o escribir otro.
- **El modelo de una línea** se asigna como una línea de una compra anterior con la misma descripción, o se
  sugiere a partir de la marca y el modelo escritos en el documento (revísalo). Puedes cambiarlo, o dejarlo
  para cuando lleguen las unidades.

### Cambios propuestos en una compra con datos

Leer un documento posterior — la factura después del presupuesto — nunca sobrescribe la compra. Cada valor
se compara con lo que tiene la compra, con la misma regla que al [vincular activos](#elegir-qué-valores-copiar):

- un valor que la compra **todavía no tiene** viene marcado (**Completar**);
- un valor que **reemplazaría** otro distinto **nunca** viene marcado (**Reemplazar**): marca los que
  quieras;
- un valor que la compra ya tiene queda afuera.

Una línea del documento con la **misma descripción** que una línea de la compra propone cambios en esa
línea (cantidad, precio unitario, garantía); cualquier otra línea se ofrece como **línea nueva**. Cambiar la
moneda la cambia para toda la compra, y el formulario lo avisa.

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
de consumible, quién aplicó asientos de una línea de licencia, quién canceló unidades restantes (con el
motivo), quién agregó o quitó un documento o cambió su tipo, quién leyó un documento con IA (y con qué
proveedor — nunca los valores leídos) y si la compra se creó a partir de activos seleccionados. No se puede
editar ni borrar.

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

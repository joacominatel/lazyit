---
title: Usar el chat
order: 1
category: ai-assistant
subcategory: using-the-chat
---

# Usar el chat

El asistente de IA es un chat dentro de lazyit. Le pedís las cosas con tus palabras — "¿qué laptops no
están asignadas?", "asigná MBP-042 a Ana Ruiz", "llevame a la aplicación VPN" — y el asistente busca
información, propone cambios y te abre páginas. Trabaja **con tus permisos**: solo puede ver y hacer lo que
vos podés ver y hacer.

El chat solo aparece cuando un administrador activó el asistente y tu rol incluye el permiso **Usar el
asistente de IA** (`ai:use`). Si no lo ves, pedíselo a un administrador — mirá
[Permisos](/help/permissions).

## Abrir y cerrar el chat

- Hacé clic en la **burbuja de chat** de la barra superior, o presioná **⌘J** (Mac) / **Ctrl+J** (Windows,
  Linux).
- En una pantalla ancha el chat queda al lado de la página, así podés seguir trabajando y ver cómo se
  actualiza. En una pantalla más chica flota sobre el lado derecho, y en el celular ocupa toda la pantalla.
- Presioná **Esc** o la **×** para cerrarlo. Cerrar el chat no detiene una respuesta en curso; cuando lo
  volvés a abrir, sigue donde estaba.

### Agrandar el chat

Cuando una respuesta o una tarjeta de cambio necesita más lugar, ensanchá el chat:

- Elegí **Ampliar** (las flechas al lado de la **×**) para ensancharlo; elegilo de nuevo para volver al ancho
  normal.
- O arrastrá el borde izquierdo del chat. Con el teclado, llegá al borde con **Tab** y usá **←** / **→**
  (mantené **Shift** para pasos más grandes), **Inicio** / **Fin** para el más angosto y el más ancho, y
  **Enter** para volver al ancho normal. Hacer doble clic en el borde hace lo mismo.

Un chat más ancho de lo normal flota **sobre** la página en lugar de achicarla; la página de abajo queda como
estaba. lazyit recuerda el ancho que elegiste en este navegador. En el celular el chat siempre ocupa toda la
pantalla.

## Preguntar algo

Escribí en el cuadro de abajo y presioná **Enter** para enviar. **Shift+Enter** agrega una línea nueva.

Mientras el asistente trabaja, ves qué está haciendo, una línea corta por paso — por ejemplo
"Listo: Buscar activos". Cuando repite la misma búsqueda varias veces seguidas, los pasos comparten una
línea con la cantidad, como "Listo: Buscar usuarios ×5". Elegí **Ver detalles** en una línea para ver qué
encontró. La respuesta aparece a medida que se escribe.

Para detener una respuesta, presioná el botón **Detener**. Lo que ya se escribió se conserva.

> [!WARNING]
> No pegues contraseñas, claves de API ni otros secretos en el chat. Lo que escribís, y lo que el asistente
> lee para responderte, se envía al proveedor de IA que configuró tu administrador.

### Comandos

Escribí **/** al principio del cuadro de mensaje para ver los comandos. Seguí escribiendo para filtrarlos,
movete con **↑** / **↓** y presioná **Enter** (o **Tab**) para ejecutar uno; **Esc** cierra la lista. También
podés escribir el comando completo, como `/copy`, y presionar **Enter**.

| Comando | Qué hace |
| --- | --- |
| `/copy` | Copia toda la conversación al portapapeles como Markdown — tus mensajes, las respuestas, los pasos y las tarjetas de cambio. |
| `/new` | Empieza un chat nuevo. |
| `/help` | Muestra los comandos y los atajos de teclado dentro del chat. |

Los comandos se ejecutan en tu navegador: nunca se envían al asistente ni al proveedor de IA. Si tu mensaje
solo empieza con una barra pero no es un comando (por ejemplo, una ruta de archivo), se envía como un
mensaje normal.

### La página actual

Cuando estás en la página de un elemento — un activo, un usuario, una aplicación, una ubicación, un
consumible — el chat muestra un chip como **Sobre: Activo de esta página** arriba del cuadro de mensaje. Así
el asistente sabe a qué elemento te referís con "este". Solo se envía la dirección de la página, nunca lo
que hay en pantalla. Elegí la **×** del chip para no incluirlo en tu próximo mensaje.

## Los cambios necesitan tu aprobación

El asistente nunca cambia nada por su cuenta. Cuando quiere crear, editar, asignar, archivar u otorgar algo,
muestra una **tarjeta** que describe exactamente qué va a pasar y espera que lo **Apruebes** o lo
**Rechaces**. Mirá [Aprobar cambios](/help/ai-assistant-approvals).

Cuando aprobás, el cambio se hace con tu cuenta, como cualquier otro cambio tuyo, y la página que tenés
abierta se actualiza sola — un activo nuevo aparece en la lista que estás mirando.

## Enlaces y apertura de páginas

Cuando el asistente crea o cambia algo, el chat muestra un botón **Abrir ‹elemento›** que te lleva ahí. Si le
pedís que te lleve a algún lado ("abrí la laptop de Ana"), te abre esa página — salvo que tengas cambios sin
guardar en un formulario: en ese caso muestra el botón **Abrir** para que no pierdas lo que escribiste.

Los enlaces a otros sitios que escribe el asistente se abren en una pestaña nueva y muestran su dirección
completa al lado — revisala antes de hacer clic. Las imágenes de las respuestas nunca se cargan.

## Tu historial de chats

Elegí **Historial de chats** arriba del chat para ver tus chats anteriores, agrupados por día. Solo vos podés
ver tus chats — los administradores no pueden leerlos.

- Elegí un chat para continuarlo.
- Elegí **Nuevo chat** para empezar de cero.
- Elegí el ícono de la **papelera** para eliminar un chat. Eliminarlo borra la conversación definitivamente;
  los cambios que hizo el asistente quedan en el registro de actividad. Un chat que todavía está
  respondiendo no se puede eliminar — detenelo primero.

Los chats también se eliminan automáticamente después de la cantidad de días que configuró tu administrador;
el historial lo indica.

### Chats de solo lectura

Un chat pasa a ser de **solo lectura** cuando tu administrador cambia el proveedor o el modelo de IA, o cuando
la conversación se vuelve demasiado larga para que la IA la siga. Podés seguir leyéndolo; elegí **Empezar un
nuevo chat** para continuar.

## Cuando algo sale mal

El chat te lo dice con palabras simples y te ofrece qué hacer:

| Mensaje | Qué hacer |
| --- | --- |
| El proveedor de IA está ocupado / no responde | Elegí **Reintentar**, o esperá un momento. |
| Esta conversación es demasiado larga para continuar | Elegí **Empezar un nuevo chat**. |
| Otra ventana ya está respondiendo en este chat | El chat muestra esa respuesta; esperá a que termine. |
| Se alcanzó el presupuesto diario de IA | Probá de nuevo mañana, o consultá a un administrador. |
| El proveedor de IA rechazó las credenciales | Un administrador tiene que revisar la configuración de IA. |
| Se perdió la conexión | Elegí **Reconectar**. La respuesta sigue en el servidor; no se pierde nada. |
| Se desactivó el asistente de IA | El chat se cierra. Un administrador desactivó el asistente. |

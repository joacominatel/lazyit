---
title: Usar el chat
order: 1
category: ai-assistant
subcategory: using-the-chat
---

# Usar el chat

El asistente de IA es un chat dentro de lazyit. Pedile las cosas con tus palabras — "¿qué laptops están
sin asignar?", "asigná MBP-042 a Ana Ruiz", "llevame a la aplicación VPN" — y busca información, propone
cambios y te abre páginas. Trabaja **con tus permisos**: ve y hace solo lo que podrías hacer vos, y
**cada cambio espera tu aprobación**.

El chat aparece cuando un administrador activó el asistente y tu rol incluye **Usar el asistente de IA**
(`ai:use`). Si no lo ves, pedíselo a un administrador — mirá [Permisos](/help/permissions).

> [!WARNING]
> No pegues contraseñas, claves de API ni otros secretos en el chat. Lo que escribís, y lo que el
> asistente lee para responderte, se envía al proveedor de IA que configuró tu administrador — mirá
> [Qué sale de tu servidor](/help/ai-assistant-overview#qué-sale-de-tu-servidor).

## Abrir y cerrar el chat

- Hacé clic en la **burbuja de chat** de la barra superior, o apretá **⌘J** (Mac) / **Ctrl+J** (Windows,
  Linux).
- En una pantalla ancha el chat queda al costado de la página, así ves cómo se actualiza. En una más
  chica flota sobre el lado derecho; en un teléfono ocupa toda la pantalla.
- Apretá **Esc** o **×** para cerrarlo. Cerrarlo no frena una respuesta en curso; al abrirlo de nuevo
  sigue donde estaba.

### Agrandar el chat

- Elegí **Ampliar** (las flechas al lado de **×**); elegilo de nuevo para volver al ancho normal.
- O arrastrá el borde izquierdo del chat. Con el teclado, llegá al borde con **Tab** y usá **←** / **→**
  (con **Shift** para pasos más grandes), **Inicio** / **Fin** para el más angosto y el más ancho, y
  **Enter** — o doble clic — para el ancho normal.

Un chat más ancho que lo normal flota **sobre** la página en vez de achicarla. lazyit recuerda el ancho
en este navegador.

## Preguntar algo

Escribí en el cuadro y apretá **Enter** para enviar; **Shift+Enter** empieza una línea nueva. Apretá
**Detener** para cortar una respuesta — lo que ya escribió se conserva.

Mientras trabaja ves una línea corta por paso, como "Listo: Buscar activos". Las búsquedas repetidas
comparten una línea con un contador ("Listo: Buscar usuarios ×5"). Elegí **Ver detalles** en una línea
para ver qué encontró.

### Elegir el modelo

Elegí el botón de **configuración** debajo del cuadro de mensaje (muestra el modelo del chat) **antes de
tu primer mensaje**:

- **Modelo** — los modelos que ofrece tu proveedor, o el **Modelo predeterminado** del administrador. Para
  uno que no aparece, escribí su id en el buscador y elegí **Usar "‹id›"**.
- **Esfuerzo de razonamiento** — *Bajo*, *Medio* o *Alto*, cuando el proveedor lo soporta. Más esfuerzo
  piensa más y usa más tokens.
- **Temperatura** — de 0 a 2, solo para un servidor propio compatible con OpenAI.
- **Aprobar automáticamente los cambios básicos** — mirá
  [Aprobación automática](/help/ai-assistant-approvals#aprobación-automática).

Una vez empezado el chat, el modelo, el esfuerzo y la temperatura quedan fijos (el botón muestra un
**candado**); para cambiarlos, empezá un chat nuevo. La aprobación automática se puede cambiar cuando
quieras.

### La página actual

En una página sobre un elemento — un activo, un usuario, una aplicación, una ubicación, un consumible —
el chat muestra una etiqueta como **Sobre: Activo de esta página**, así el asistente sabe a qué te
referís con "este". Solo se envían la dirección de la página y qué registro es, nunca lo que hay en
pantalla. Elegí **×** en la etiqueta para no incluirla en tu próximo mensaje.

### Comandos

Escribí **/** al principio del cuadro de mensaje para ver los comandos; seguí escribiendo para filtrar,
**↑** / **↓** para moverte, **Enter** o **Tab** para ejecutar, **Esc** para cerrar.

| Comando | Qué hace |
| --- | --- |
| `/copy` | Copia toda la conversación como Markdown — mensajes, respuestas, pasos y tarjetas de cambio. |
| `/new` | Empieza un chat nuevo. |
| `/help` | Muestra los comandos y atajos de teclado. |
| `/model` | Abre el selector de modelo; `/model <id>` lo fija directamente. Solo antes del primer mensaje. |
| `/auto on` · `/auto off` | Activa o desactiva la [aprobación automática](/help/ai-assistant-approvals#aprobación-automática) en este chat; `/auto` solo la alterna. |

Los comandos corren en tu navegador y nunca se envían al proveedor. Un mensaje que solo empieza con una
barra (una ruta de archivo, por ejemplo), o un comando seguido de palabras que no entiende, se envía
como mensaje normal.

## Aprobar lo que propone

Cuando el asistente quiere crear, editar, asignar, archivar u otorgar algo, muestra una **tarjeta** con
exactamente lo que va a pasar y espera **Aprobar** o **Rechazar**. El cambio aprobado se hace con tu
cuenta, y la página que tenés abierta se actualiza sola. Cómo leer una tarjeta, los cambios en lote, las
contraseñas y la aprobación automática están en [Aprobar cambios](/help/ai-assistant-approvals).

Las tarjetas y las líneas de pasos se escriben en tu idioma; una frase que lazyit todavía no tiene
traducida se muestra en inglés.

## Cuando el asistente te pide datos

Cuando necesita algo que no encuentra en lazyit — el sitio adonde van las laptops nuevas, sus números de
serie, una fecha — el asistente muestra un **formulario** corto con el título **El asistente pregunta**,
en vez de adivinar.

- Los campos marcados con **\*** son obligatorios; los **Recomendado** lo ayudan a hacerlo mejor; los
  **Opcional** están en **Más detalles**.
- Algunos formularios piden una lista, una **fila** por elemento: usá **Agregar una fila** y el ícono de
  **papelera**, dentro de la cantidad de filas que pide el formulario.
- Las listas de sitios, categorías, modelos o fabricantes salen de lazyit y muestran solo lo que podés
  ver.

| Botón | Qué pasa |
| --- | --- |
| **Enviar** | Tu respuesta va al asistente. Un campo faltante o inválido queda resaltado y no se envía nada. |
| **Continuar sin esto** | El asistente sigue sin esos datos — puede hacer menos, o preguntarte con palabras. |
| **No preguntar** | Se le indica al asistente que no vuelva a pedir esos datos en este chat. |

Mientras un formulario espera, el cuadro de mensaje queda en pausa con un botón **Ir al formulario**, y
el historial marca el chat con **Espera tu respuesta**. El formulario espera lo mismo que una tarjeta de
cambio (30 minutos por defecto; muestra **Respondé antes de las …**); si nadie responde, vence y el
asistente se detiene — mandá un mensaje nuevo para seguir. Los formularios respondidos quedan en la
conversación, de solo lectura.

> [!WARNING]
> El asistente nunca pide contraseñas, claves ni otros secretos en un formulario, y lazyit rechaza un
> formulario que lo haga. Tampoco escribas secretos en los campos de texto.

## Enlaces y apertura de páginas

Después de un cambio, el chat muestra un botón **Abrir ‹elemento›**. Si le pedís que te lleve a algún
lado ("abrí la laptop de Ana"), abre la página — salvo que un formulario de la página tenga cambios sin
guardar; en ese caso muestra el botón **Abrir**, así no perdés nada.

Los enlaces a otros sitios se abren en una pestaña nueva y muestran su dirección completa — revisala
antes de hacer clic. Las imágenes de las respuestas nunca se cargan.

## Fuentes de la web

Si tu administrador activó la **búsqueda web**, el asistente puede buscar en internet cuando los
registros y la base de conocimiento de lazyit no tienen la respuesta; si está desactivada, te pide la
documentación. Las páginas que usó aparecen debajo de la respuesta como **Fuentes de la web**, y cada
una se abre en una pestaña nueva. Las escribieron otras personas: verificalas antes de basarte en ellas.

Una vez que el asistente buscó en la web en un chat, **ya no se aprueba automáticamente nada en ese
chat** — cada cambio necesita tu aprobación. Empezá un chat nuevo para volver a usar la aprobación
automática.

## Tu historial de chats

Elegí **Historial de chats** arriba del chat para ver tus chats anteriores, agrupados por día. Solo vos
los ves — los administradores no.

- Elegí un chat para seguirlo, o **Nuevo chat** para empezar de cero.
- Elegí el ícono de **papelera** para borrar un chat para siempre. Los cambios que hizo el asistente
  quedan en el registro de actividad y en el registro de acciones de IA. Un chat que todavía está
  respondiendo no se puede borrar — detenelo primero.

Los chats también se borran solos después de la retención que fijó tu administrador; el historial lo
indica.

### Chats de solo lectura

Un chat pasa a **solo lectura** — lo podés leer, pero no seguir — cuando:

- un administrador cambió el proveedor de IA, o el modelo por defecto que usaba el chat (un chat donde
  elegiste el modelo sobrevive a un cambio del modelo por defecto);
- un administrador desactivó la búsqueda web y el chat la tenía;
- lazyit se actualizó y cambiaron las herramientas o las instrucciones del asistente;
- la conversación se hizo demasiado larga para el modelo.

Elegí **Empezar un nuevo chat** para seguir.

## Cuando algo sale mal

El chat te dice qué pasó con palabras simples y ofrece el paso siguiente — **Reintentar**, **Empezar un
nuevo chat** o **Reconectar**. Cerrar el chat o perder la conexión nunca pierde una respuesta: sigue en
el servidor. Para cada mensaje, su causa y su solución, mirá
[Resolución de problemas](/help/ai-assistant-troubleshooting#mensajes-del-chat).

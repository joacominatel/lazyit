---
title: Aprobar cambios
order: 1
category: ai-assistant
subcategory: approvals
---

# Aprobar cambios

Cada cambio que el asistente quiere hacer — crear, editar, asignar, archivar, otorgar o revocar accesos —
espera por vos. Aparece en el chat como una **tarjeta**, y no pasa nada hasta que elegís **Aprobar**, salvo
que hayas activado la aprobación automática de cambios básicos en ese chat (ver más abajo). Esta página
explica cómo leer una tarjeta y qué pasa cuando decidís.

## Leer una tarjeta

La tarjeta la arma lazyit a partir del cambio exacto que se va a ejecutar — **no** a partir de lo que el
asistente escribió en el chat. Si alguna vez no coinciden, confiá en la tarjeta.

De arriba hacia abajo:

1. **El tipo de cambio** — *Cambio propuesto*, o *Cambio sensible* para cambios en accesos, roles,
   identidad o inicio de sesión de personas, y un sello de estado (**Pendiente**, **Hecho**, **Rechazado**…).
2. **Qué va a pasar**, en una oración — por ejemplo *"Dar a Ana Ruiz acceso Admin a VPN. Esto dispara el
   aprovisionamiento automático mediante el workflow configurado para VPN."*
3. **Se aplica a** — el elemento que cambia, con un enlace.
4. **Antes → después** — cada campo que cambia, con el valor actual tachado y el nuevo al lado. Valores como
   contraseñas se muestran como **Oculto**, nunca en claro.
5. **También afecta a** — otros elementos que toca el cambio, como "También afecta a 3 asignaciones".
6. **Antes de aprobar** — advertencias en palabras simples, como:
   - *Crea un acceso en un sistema externo mediante una automatización.*
   - *También revoca los accesos vinculados.*
   - *Envía notificaciones a personas.*
   - *No se puede deshacer.*
   - *Afecta a una aplicación marcada como crítica.*
7. **Te espera hasta las…** — una propuesta vence después de un rato (30 minutos por defecto). Después,
   pedíselo de nuevo al asistente.

El texto que escribieron otras personas — un artículo, una nota, la descripción de una aplicación — se muestra
como texto plano en *cursiva* para que lo distingas.

### "Basado en contenido escrito por otras personas"

Si el asistente leyó contenido que escribieron otras personas antes de proponer el cambio, la tarjeta muestra
una nota amarilla **Basado en contenido escrito por otras personas** con enlaces a lo que leyó. Un contenido
puede tener instrucciones pensadas para engañar a una IA. Verificá que el cambio sea realmente lo que **vos**
pediste antes de aprobarlo.

## Aprobar o rechazar

- **Aprobar** hace el cambio con tu cuenta, exactamente como se muestra. La tarjeta pasa a **Hecho**, y un
  botón **Abrir** te lleva al resultado. La página que tenés abierta se actualiza sola.
- **Rechazar** hace que no cambie nada. El asistente se entera de que lo rechazaste y puede sugerir otra
  cosa — decile qué cambiar.

Cada cambio se decide en su propia tarjeta o página. Nada se aprueba presionando Enter en el cuadro de
mensaje.

## Varios cambios a la vez

Cuando el asistente propone más de un cambio en el mismo paso — por ejemplo, actualizar cinco activos —
aparecen como **una tarjeta con páginas** en lugar de una pila de tarjetas:

- Arriba, la tarjeta dice **Cambios propuestos · 5 cambios** y en qué página estás (**2 de 5**). Usá las
  flechas, o elegí un número de página, para moverte entre ellos; sobre los números de página también
  funcionan las flechas izquierda y derecha del teclado. Una página ya decidida muestra una tilde (aprobado o
  hecho) o un círculo tachado (rechazado o vencido).
- Cada página es la misma tarjeta que se describe arriba — qué va a pasar, antes → después, las advertencias
  y, cuando hace falta, tu contraseña — con sus propios **Aprobar** y **Rechazar**. Cuando decidís una página,
  la tarjeta pasa al siguiente cambio pendiente.
- **Aprobar todos** y **Rechazar todos** deciden, uno por uno, solo los cambios que no necesitan una mirada
  más atenta; el número del botón dice cuántos. **Nunca** incluyen un cambio que necesita tu contraseña
  (roles, identidad, accesos, inicio de sesión, una aplicación marcada como crítica), un *Cambio sensible*, un
  cambio basado en contenido escrito por otras personas, ni uno cuya última decisión fue rechazada — por
  ejemplo, porque el elemento cambió mientras tanto. La tarjeta indica cuántos quedaron afuera y por qué;
  decidilos en su propia página.
- Si algunos cambios de una acción masiva no se pueden decidir, los demás sí se deciden, y la tarjeta lista
  los que fallaron con un enlace a su página.

Si el asistente intentó proponer cambios que se rechazaron antes de convertirse en una tarjeta, aparecen en
**una sola línea** — por ejemplo *"20 cambios no se pudieron proponer"* — con **Ver detalles** para ver los
motivos.

## Cambios que necesitan tu contraseña

Algunos cambios te piden tu **contraseña de lazyit** en la tarjeta antes de poder aprobarlos:

- darle a alguien acceso o privilegios;
- cambiar el rol o la identidad de alguien;
- enviarle a alguien una forma de iniciar sesión;
- **cualquier cambio que el asistente haga sobre una aplicación marcada como crítica.**

Estas advertencias muestran la etiqueta **Requiere tu contraseña**. Escribí tu contraseña en la tarjeta y
elegí **Aprobar**. Confirma que realmente sos vos quien está frente al teclado; tu sesión sigue iniciada en
cualquier caso.

| Mensaje | Qué significa |
| --- | --- |
| Esa contraseña no es correcta | Escribila de nuevo. |
| Demasiadas contraseñas incorrectas. Probá de nuevo en … | Esperá el tiempo indicado; el botón Aprobar vuelve solo. |
| La confirmación con contraseña no está disponible con tu forma de iniciar sesión | Tu cuenta inicia sesión sin una contraseña de lazyit, así que este cambio no se puede aprobar desde el chat. Hacelo desde la página del elemento. |

## Cuando la tarjeta cambia

lazyit revisa el cambio de nuevo en el momento en que aprobás. Si algo cambió desde que se mostró la tarjeta
— por ejemplo, la aplicación se marcó como crítica mientras tanto — no se aplica nada. La tarjeta se
actualiza, las advertencias nuevas se resaltan con la etiqueta **Nuevo**, y te pide la contraseña si ahora la
necesita. Revisala y decidí de nuevo.

Otras cosas que podés ver:

| Mensaje | Qué significa |
| --- | --- |
| El elemento cambió después de la propuesta | Alguien lo editó mientras tanto. No se aplicó nada; el asistente lo revisa de nuevo y puede proponer un cambio actualizado. |
| Esta propuesta venció | Pasó demasiado tiempo. Pedila de nuevo si todavía querés el cambio. |
| Este cambio ya se decidió | Vos (u otra ventana tuya) ya lo aprobaste o rechazaste. |
| Se desactivó el asistente de IA | Un administrador desactivó el asistente; el cambio no se puede aprobar desde el chat. |

## Crear muchos activos a la vez

Cuando le das al asistente una lista — "agregá estas 40 notebooks", una planilla pegada — propone **una
sola tarjeta para todo el lote** (hasta 200 activos) en lugar de 40 tarjetas separadas. Aprobás o rechazás
el lote completo.

La tarjeta muestra:

- **Qué va a pasar**, en una frase — por ejemplo *"Create 16 of 17 assets; 1 row skipped as requested."*
- **Un resumen** — cuántas filas hay, cuántas se van a crear, cuántas se omiten y los **valores por
  defecto aplicados** (ver más abajo).
- **Una tabla**, una fila por activo: el número de fila, nombre, etiqueta, número de serie, modelo,
  categoría, ubicación y estado, más una columna **Problemas**. La tabla se desplaza dentro de la tarjeta;
  en el teléfono, deslizala hacia los costados. Activá **Solo filas con problemas** para ocultar las filas
  que están bien.

**Filas omitidas.** Una fila marcada **Omitida — no se aplica** se muestra para que veas qué quedó afuera y
por qué (los motivos están en la columna **Problemas**), pero **nunca se crea** — aunque el problema se
resuelva antes de que apruebes. El asistente solo omite una fila cuando te lo dijo; una lista en la que una
fila todavía tiene un problema sin resolver (un modelo que aún no existe, una etiqueta duplicada) no se
propone hasta que el asistente lo arregla u omite esa fila. Así, cada fila de la tarjeta que no está
omitida estaba verificada y lista cuando se armó la tarjeta, y esas filas — y solo esas — se crean cuando
aprobás.

**Duplicados.** Si una etiqueta o un número de serie ya pertenece a un activo existente, la columna
**Problemas** lo dice y enlaza a ese activo. Un valor repetido entre dos filas de la misma lista se muestra
igual ("… también se usa en la fila 3"). Si no se pudo completar la comprobación de duplicados — no podés ver
todos los activos, o una etiqueta o número de serie contiene una coma y no se pudo buscar — la tarjeta lo
avisa: una fila cuya etiqueta o número de serie ya esté en uso se
rechaza al ejecutarse, y las demás se ejecutan igual.

**Estado por defecto.** Un activo nuevo que el asistente crea sin estado empieza como **En depósito**
(stock nuevo). La tarjeta marca esos valores como **(por defecto)** y los lista en **Valores por defecto
aplicados**. Si no es lo que querés, rechazá la tarjeta y decile al asistente qué estado usar.

Cuando el lote se ejecuta, cada activo se crea por separado, igual que si lo hubieras creado a mano. Si en
ese momento se rechaza una fila, las demás se ejecutan igual y el asistente te dice qué fila falló y por
qué.

## Categorías, modelos y ubicaciones

El asistente también puede mantener ordenada tu clasificación, siempre con una tarjeta:

- **Categorías** — crear, renombrar o editar categorías de activos, aplicaciones y consumibles, y archivar
  una que ya no usás (**category_create**, **category_update**, **category_archive**). Las carpetas de la
  base de conocimiento se manejan aparte.
- **Modelos de activo** — editar, archivar y restaurar un modelo (**asset_model_update**,
  **asset_model_archive**, **asset_model_restore**).
- **Ubicaciones** — editar (incluso moverla debajo de otra), archivar y restaurar una ubicación
  (**location_update**, **location_archive**, **location_restore**).

Una tarjeta de **archivado** lleva la advertencia *"Lo archiva. Se puede restaurar después."* y dice
qué lo sigue usando — por ejemplo *"También afecta a 12 activos"*, con algunos nombrados. Si no tenés
permiso para ver algunos de esos registros, la fila **Usado por** de la tarjeta dice *"Unknown to you: …"*
(desconocido para vos) en lugar de mostrar cero: el elemento puede seguir en uso por registros que no ves. Las categorías archivadas no se restauran
desde el chat; restauralas desde **Configuración → Taxonomías**.

## Etiquetas de activos

El asistente sigue el [esquema de etiquetas de activos](/help/configuration-asset-tag-scheme) de tu
instancia:

- Cuando crea activos, deja la etiqueta vacía salvo que vos le des una, así lazyit asigna la siguiente
  etiqueta del esquema — igual que cuando creás un activo a mano. Nunca inventa una etiqueta a partir del
  patrón.
- Puede cambiar la etiqueta de **un activo** cuando se lo pedís, con la tarjeta de siempre.
- Cambia el esquema **de toda la instancia** (**Configuración → Instancia → Esquema de etiquetas de
  activos**) solo cuando le pedís explícitamente que cambie el esquema general de etiquetas — nunca solo
  para que encaje la etiqueta de un activo. Esa tarjeta es un *Cambio sensible* con la advertencia
  *"Cambia la configuración de toda la instancia: se aplica a todos desde ahora."*, muestra solo lo
  que cambia (prefijo, sufijo, dígitos o próximo número) antes → después, además de la próxima etiqueta, y siempre te espera: la
  [aprobación automática](#aprobación-automática) nunca la saltea. Las etiquetas existentes nunca se
  reescriben.

Solo los administradores pueden ver o cambiar el esquema; para el resto, el asistente simplemente deja que
lazyit asigne la etiqueta.

## Aprobación automática

Si confiás en el asistente para trabajo de rutina en un chat, podés dejar que aplique los **cambios
básicos** sin tarjeta. Activala en los ajustes del chat (el botón debajo del cuadro de mensaje) con
**Aprobar automáticamente los cambios básicos**, o escribí `/auto on`. La primera vez, lazyit te explica qué
hace y te pide que confirmes.

Mientras está activada:

- **Las ediciones básicas se aplican en el momento** — crear o actualizar un activo, un artículo, un
  consumible y similares. Se hacen con tu cuenta y tus permisos, igual que si las hubieras aprobado, y
  aparecen en el chat como un registro compacto **Aplicado automáticamente** con el elemento, un enlace a él
  y los valores antes → después. Un [lote de activos nuevos](#crear-muchos-activos-a-la-vez) también es un
  cambio básico: con la aprobación automática activada, toda la lista (hasta 200 activos) se crea sin
  tarjeta, y el registro muestra su tabla.
- **Todo lo crítico sigue mostrando una tarjeta y te espera**: roles, identidad e inicio de sesión,
  accesos, credenciales, aplicaciones marcadas como críticas, cambios sensibles (los marcados como
  *Cambio sensible*) y todo lo que necesita tu contraseña.
- **Un cambio propuesto después de que el asistente leyó contenido escrito por otras personas** también
  sigue mostrando una tarjeta — ese contenido podría estar intentando dirigir al asistente.
- **Una vez que el asistente buscó en la web en un chat**, nada en ese chat se aprueba automáticamente: los
  resultados de la búsqueda quedan en la conversación.
- Una etiqueta **Auto** arriba del chat te recuerda que el modo está activado.

Se aplica **solo a ese chat** y está desactivada en cada chat nuevo. Desactivala cuando quieras con el
mismo interruptor o con `/auto off`; una tarjeta que ya te está esperando nunca se aprueba por activarla.

> [!WARNING]
> Con la aprobación automática activada, un cambio básico se hace sin que lo mires antes. Usala en chats
> donde hacés ediciones de rutina, y revisá los registros **Aplicado automáticamente** a medida que
> aparecen.

Cada cambio automático queda registrado como cualquier otro cambio tuyo — en el historial del elemento y en
el registro de actividad, a tu nombre — y el registro de acciones de IA anota que se aplicó
automáticamente.

## Dónde quedan registrados los cambios aprobados

Un cambio aprobado se hace con tu cuenta, así que queda registrado como cualquier cambio que hacés vos: en el
historial del elemento y en el registro de actividad, a tu nombre. lazyit además guarda cada cambio que
propuso el asistente, y lo que decidiste, en un registro permanente de acciones de IA que se conserva aunque
elimines el chat.

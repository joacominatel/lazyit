---
title: Aprobar cambios
order: 1
category: ai-assistant
subcategory: approvals
---

# Aprobar cambios

Cada cambio que el asistente quiere hacer — crear, editar, asignar, archivar, otorgar o revocar
accesos — aparece en el chat como una **tarjeta**, y no pasa nada hasta que elegís **Aprobar** (salvo que
hayas activado la [aprobación automática](#aprobación-automática) para cambios básicos en ese chat). Esta
página explica cómo leer una tarjeta y qué pasa cuando decidís.

Esto es el chat integrado. Los agentes externos por MCP no muestran tarjetas de lazyit — es el cliente
el que decide si te pregunta; mirá
[Claude Code y MCP](/help/ai-assistant-claude-code-mcp#antes-de-conectar-en-qué-confiás).

## Leer una tarjeta

lazyit arma la tarjeta a partir del cambio exacto que se va a ejecutar — **no** de lo que escribió el
asistente. Si alguna vez no coinciden, confiá en la tarjeta. Las tarjetas se muestran en tu idioma.

De arriba abajo:

1. **El tipo de cambio** — *Cambio propuesto*, o *Cambio sensible* para accesos, roles, identidad,
   inicio de sesión y configuración de toda la instancia — y un sello de estado (**Pendiente**,
   **Hecho**, **Rechazado**…).
2. **Qué va a pasar**, en una frase — por ejemplo *"Dar a Ana Ruiz acceso Admin a VPN. Esto dispara el
   aprovisionamiento automático mediante el workflow configurado para VPN."*
3. **Se aplica a** — el elemento que cambia, con un enlace.
4. **Antes → después** — cada campo que cambia. Valores como contraseñas aparecen como **Oculto**.
5. **También afecta** — otros elementos que toca el cambio, como "También afecta a 3 asignaciones".
6. **Antes de aprobar** — avisos simples, como *Crea acceso en un sistema externo mediante una
   automatización*, *También revoca los accesos asociados*, *Envía notificaciones a personas*, *No se
   puede deshacer* o *Afecta a una aplicación marcada como crítica*.
7. **Te espera hasta las…** — una propuesta vence (a los 30 minutos por defecto). Después, pedila de
   nuevo.

El texto que escribieron otras personas — un artículo, una nota, una descripción — se muestra como
texto plano en *cursiva*.

### "Basado en contenido escrito por otras personas"

Si el asistente leyó contenido de otras personas antes de proponer el cambio — un artículo, una nota,
un fragmento de búsqueda, una página web — la tarjeta muestra un aviso amarillo **Basado en contenido
escrito por otras personas**, con enlaces a lo que leyó cuando hay una sola página que enlazar. Ese
contenido puede esconder instrucciones pensadas para engañar a una IA. **Verificá que el cambio sea
realmente lo que pediste.**

El aviso es cauteloso a propósito: el texto que escribiste vos, como tus propias notas en un activo,
también cuenta.

## Aprobar o rechazar

- **Aprobar** hace el cambio con tu cuenta, exactamente como se muestra. La tarjeta pasa a **Hecho**, un
  botón **Abrir** te lleva al resultado y la página que tenés abierta se actualiza.
- **Rechazar** no cambia nada. Al asistente se le avisa que lo rechazaste — decile qué hacer en su lugar.

Nunca se aprueba nada apretando Enter en el cuadro de mensaje.

## Cambios que necesitan tu contraseña

Algunas tarjetas piden tu **contraseña de lazyit** antes de que funcione **Aprobar** — muestran la
etiqueta **Requiere tu contraseña**:

- dar acceso o privilegios a alguien;
- cambiar el rol o la identidad de alguien;
- enviarle a alguien una forma de iniciar sesión;
- **cualquier cambio en una aplicación marcada como crítica.**

La contraseña confirma que sos vos quien está en el teclado; tu sesión no se toca. Después de cinco
contraseñas incorrectas, lazyit te hace esperar: empieza en un segundo y crece hasta 15 minutos; el botón
**Aprobar** vuelve solo. La espera es compartida con la contraseña de la pantalla de consentimiento de
MCP.

Si tu cuenta inicia sesión sin contraseña de lazyit (a través de tu proveedor de identidad), estos
cambios no se pueden aprobar desde el chat — hacelos desde la página del elemento.

## Varios cambios a la vez

**Hasta 5 por vez.** Como máximo **5** cambios pueden esperar aprobación en un paso. Si pedís más —
"pasá estas 25 laptops a depósito" — el asistente trabaja por tandas: propone 5, te dice por dónde va
(*"5 de 25"*) y propone los 5 siguientes cuando decidiste. Si intentó más en un mismo paso, aparecen en
una línea — *"20 cambios no se pudieron proponer"* — cuyo **Ver detalles** dice que se alcanzó el
límite; es lo esperado, no un error. Si se detiene antes de terminar una lista larga, decile que siga.

**Una tarjeta con páginas.** Los cambios de un paso aparecen como **una tarjeta con páginas** — **Cambios
propuestos · 5 cambios**, y en qué página estás (**2 de 5**). Movete con las flechas o con los números
de página (ahí también funcionan las flechas izquierda y derecha del teclado). Cada página es una
tarjeta completa con su propio **Aprobar** y **Rechazar**; después de decidir una, la tarjeta pasa a la
siguiente pendiente.

**Aprobar todos y Rechazar todos** deciden, uno por uno, todos los cambios pendientes **excepto** los
que necesitan una mirada más atenta — el número del botón dice cuántos. Nunca incluyen:

- un cambio que necesita tu contraseña;
- un *Cambio sensible*;
- un cambio cuya última decisión fue rechazada — por ejemplo porque el elemento cambió mientras tanto.

La tarjeta indica cuántos quedaron afuera y por qué; decidilos en su propia página. **Un cambio basado
en contenido escrito por otras personas sí se incluye**, así que revisá su página antes si tiene ese
aviso. Si algunos cambios no se pueden decidir, los demás igual se deciden, y la tarjeta enlaza a los
que fallaron.

## Listas de activos

Para muchos activos a la vez, el asistente propone **una sola tarjeta para toda la lista** (hasta 200
activos) en vez de una por activo. Aprobás o rechazás la lista entera; después cada activo se crea o se
actualiza por separado, exactamente como si lo hubieras hecho a mano.

### Crear muchos activos a la vez

Cuando le das una lista al asistente — "agregá estas 40 laptops", una planilla pegada — la tarjeta
muestra:

- **Qué va a pasar** — por ejemplo *"Crear 16 de 17 activos; se omite 1 fila, como se pidió."*
- **Un resumen** — filas, cuántos se van a crear, cuántos se omiten y los **valores por defecto
  aplicados**.
- **Una tabla**, una fila por activo (número de fila, nombre, etiqueta, número de serie, modelo,
  categoría, ubicación, estado y **Problemas**). Se desplaza dentro de la tarjeta; en el teléfono,
  deslizala. **Solo filas con problemas** oculta el resto.

Las filas marcadas **Omitida — no se aplica** se muestran con sus motivos pero **nunca se crean**, aunque el problema
desaparezca. El asistente solo omite una fila después de avisarte; una lista con un problema sin
resolver (un modelo que todavía no existe, una etiqueta duplicada) no se propone hasta que se corrija u
omita. Así que cada fila no omitida fue comprobada cuando se armó la tarjeta.

**Duplicados.** Una etiqueta o número de serie que ya tiene otro activo se marca con un enlace a ese
activo; uno repetido dentro de la lista lo indica ("… también se usa en la fila 3"). Si la comprobación no
se pudo completar — no podés leer todos los activos, o un valor tiene una coma — la tarjeta lo dice, y un
valor ocupado se rechaza cuando se ejecuta esa fila.

**Estado por defecto.** Un activo creado sin estado empieza como **En depósito**; la tarjeta lo marca
como **(por defecto)**. Si no es lo que querés, rechazá y decile al asistente qué estado usar.

Si una fila se rechaza al ejecutarse la lista, las demás igual se ejecutan y el asistente te dice cuál
falló.

### Editar muchos activos a la vez

Para ediciones parecidas en activos existentes — un estado, una ubicación, un modelo, una empresa,
fechas, costo o atributos — la tarjeta es el mismo tipo de tabla: primero la columna **Activo**, después
el antes → después de cada campo que cambia. Si alguien edita uno de esos activos (o el modelo o la
ubicación a la que apunta) antes de que apruebes, no se aplica nada y el asistente puede volver a
proponer la lista. Las etiquetas y los números de serie se cambian de a un activo.

## Cuando la tarjeta cambia mientras decidís

lazyit vuelve a comprobar el cambio al aprobar. Si algo cambió desde que se mostró la tarjeta, no se
aplica nada:

| Ves | Qué significa |
| --- | --- |
| La tarjeta se actualiza, con avisos nuevos marcados **Nuevo** | El cambio en sí ahora es distinto — la aplicación se marcó como crítica, más activos usan la categoría que archiva. Revisá los números actualizados (y escribí tu contraseña si ahora la pide) y decidí de nuevo. |
| El elemento cambió después de la propuesta | Alguien lo editó mientras tanto. El asistente lo vuelve a leer y puede proponer un cambio actualizado. |
| Esta propuesta venció | Pasó demasiado tiempo. Pedila de nuevo. |
| Este cambio ya se decidió | Vos, u otra ventana tuya, ya lo decidió. |
| Se desactivó el asistente de IA | Ahora no se puede aprobar desde el chat. |

## Aprobación automática

En un chat donde le confiás al asistente el trabajo de rutina, dejá que aplique **cambios básicos** sin
tarjeta: activá **Aprobar automáticamente los cambios básicos** en los ajustes del chat, o escribí
`/auto on`. La primera vez, lazyit explica qué hace y te pide confirmar.

Mientras está activa:

- **Las ediciones básicas se aplican al instante** — crear o actualizar un activo, un artículo, un
  consumible y similares, incluida una [lista de activos](#listas-de-activos) entera. Se ejecutan con tu
  cuenta, exactamente como si las hubieras aprobado, y aparecen como un registro compacto **Aplicado
  automáticamente** con el antes → después.
- **Estos siguen mostrando tarjeta y te esperan:**
  - todo lo crítico — roles, identidad e inicio de sesión, accesos, credenciales, aplicaciones marcadas
    como críticas, cualquier *Cambio sensible*, todo lo que pide tu contraseña;
  - cualquier cambio propuesto **después de que el asistente leyó texto libre** — de otra persona o tuyo
    — en el mismo turno: un artículo, una nota, una descripción, un fragmento de búsqueda, las opciones
    que elegiste en uno de sus formularios;
  - **todos los cambios de un chat en el que el asistente buscó en la web**, por el resto de ese chat.
- Una etiqueta **Auto** arriba del chat te recuerda que está activa.

Rige **solo en ese chat** y está desactivada en cada chat nuevo. Desactivala cuando quieras con el mismo
interruptor o `/auto off`; activarla nunca aprueba una tarjeta que ya estaba esperando.

> [!WARNING]
> Con la aprobación automática activa, un cambio básico se hace sin que lo mires antes. Usala para
> ediciones de rutina, y revisá los registros **Aplicado automáticamente** a medida que aparecen.

## Categorías, modelos y ubicaciones

El asistente puede mantener ordenada tu clasificación, siempre con una tarjeta:

- **Categorías** — crear, renombrar o editar categorías de activos, aplicaciones y consumibles, y
  archivar una que ya no uses. Las carpetas de la base de conocimiento se manejan aparte.
- **Modelos de activo** — editar, archivar y restaurar.
- **Ubicaciones** — editar (incluido moverla bajo otra), archivar y restaurar.

Una tarjeta de **archivo** lleva *"Lo archiva. Se puede restaurar después."* y dice qué sigue usando el
elemento — *"También afecta a 12 activos"*, con algunos nombrados. Si no podés ver algunos de esos
registros, **Usado por** dice *"No lo podés ver: …"* en vez de cero: el elemento puede seguir en
uso. Si el número cambia antes de que apruebes, la tarjeta se actualiza como se explica en
[Cuando la tarjeta cambia mientras decidís](#cuando-la-tarjeta-cambia-mientras-decidís). Las categorías
archivadas se restauran desde **Configuración → Taxonomías**, no desde el chat.

## Etiquetas de activos

El asistente sigue tu [esquema de etiquetas de activos](/help/configuration-asset-tag-scheme):

- Al crear activos deja la etiqueta vacía salvo que le des una, así lazyit asigna la siguiente — igual
  que a mano. Nunca arma una etiqueta a partir del patrón.
- Cambia la etiqueta de **un activo** cuando se lo pedís, con la tarjeta de siempre.
- Cambia el esquema **de toda la instancia** solo cuando se lo pedís explícitamente — nunca para que
  encaje la etiqueta de un activo. Esa tarjeta es un *Cambio sensible* (*"Cambia la configuración de
  toda la instancia: se aplica a todos desde ahora."*) que muestra qué cambia y la próxima etiqueta; la
  aprobación automática nunca la saltea, y las etiquetas existentes nunca se reescriben. Solo quienes
  pueden **Configurar la instancia** pueden hacerlo.

Cualquiera que pueda crear activos puede hacer que el asistente lea el esquema y la próxima etiqueta.

## Dónde quedan registrados los cambios aprobados

Un cambio aprobado — por vos o por la aprobación automática — queda registrado como cualquier cambio
tuyo: en el historial del elemento y en el registro de actividad, a tu nombre. lazyit además guarda
cada cambio que propuso el asistente, qué decidiste y si se aplicó automáticamente, en un **registro de
acciones de IA** permanente que queda aunque borres el chat.

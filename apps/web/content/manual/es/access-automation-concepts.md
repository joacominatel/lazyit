---
title: Conceptos
order: 1
category: access-automation
subcategory: concepts
---

# Automatización de accesos — conceptos

La automatización de accesos permite que lazyit **actúe en otro sistema** cuando concedes o revocas
el acceso a una aplicación. Cuando concedes acceso a alguien, un flujo de trabajo puede crear su
cuenta en la herramienta externa; cuando lo revocas, un flujo puede desactivar esa cuenta. lazyit los
llama **flujos de trabajo**, y los configuras por aplicación desde la pestaña **Flujos de trabajo**
de cada aplicación.

Es **estrictamente opcional.** Una aplicación sin ningún flujo activado se comporta como siempre:
conceder el acceso solo registra la concesión, y no se aprovisiona nada automáticamente. La
automatización solo ocurre en las aplicaciones donde la configuras a propósito.

## Qué es un flujo de trabajo

Un flujo de trabajo está vinculado a una aplicación y a un **disparador** — el evento que lo activa:

- **Acceso concedido** — se ejecuta cuando se concede a alguien el acceso a la aplicación.
- **Acceso revocado** — se ejecuta cuando se le revoca el acceso.

Cuando un flujo se activa, lazyit inicia una **ejecución**: una secuencia ordenada de **pasos** que
llaman al sistema externo (o se pausan para que actúe una persona). Cada ejecución se registra para
que veas exactamente qué pasó, paso a paso. Otros disparadores (temporizadores, programación,
recertificación) aparecen en el producto pero están reservados para más adelante — hoy los dos
disparadores de acceso anteriores son contra los que construyes.

## La concesión es la fuente de verdad — la automatización es posterior

Este es el principio más importante que hay que entender. **La concesión de acceso dentro de lazyit
es el registro permanente.** El aprovisionamiento externo es un efecto posterior e independiente:

- Una ejecución arranca **después** de que la concesión (o revocación) ya está guardada. La concesión
  nunca queda en espera de un sistema externo.
- Si la llamada externa falla, **la concesión nunca se revierte, se bloquea ni se deshace.** La
  concesión se mantiene; la ejecución fallida se muestra como algo que tú debes corregir (consulta
  [Resolución de problemas](/help/access-automation-troubleshooting)).

En resumen: lazyit registra quién tiene acceso y *luego* intenta que el mundo exterior coincida. Un
conector roto significa que una cuenta aún no se creó — no que lazyit haya perdido el rastro del
acceso.

## Cada evento de concesión se ejecuta una vez

Cuando una concesión activa un flujo, lazyit crea **una ejecución para ese evento**. Si un paso falla
y lo reintentas, el reintento ocurre *dentro de la misma ejecución* — no crea una segunda ejecución y
no aprovisiona a la misma persona dos veces. Por eso es seguro dejar la automatización activada: una
caída pasajera produce un reintento, no una cuenta duplicada.

## Lo que no es

La automatización de accesos es **aprovisionamiento de acceso a aplicaciones** — nada más. No es un
sistema de RR. HH. ni de incorporación, no es un subsistema de gobierno de identidades o de revisión
de accesos, y no es un constructor de flujos genérico para lógica de negocio arbitraria. Los datos
que un flujo puede enviar hacia fuera se limitan a los datos básicos de la persona (correo, nombre,
apellido, id), la aplicación y el contexto de la concesión. No hay campos de rol, equipo o
responsable que mapear — por diseño.

## A dónde ir después

- [Construir un flujo de trabajo](/help/access-automation-building-a-workflow) — el constructor, las
  conexiones y los tipos de paso.
- [Tareas manuales](/help/access-automation-manual-tasks) — pasos que se pausan para una persona.
- [Pruebas y observabilidad](/help/access-automation-testing-observability) — probar una conexión,
  hacer una simulación y leer la cronología de una ejecución.
- [Permisos](/help/access-automation-permissions) — quién puede configurar, ejecutar y custodiar
  credenciales.

---
title: Pruebas y observabilidad
order: 4
category: access-automation
subcategory: testing-observability
---

# Pruebas y observabilidad

Puedes validar un flujo antes de activarlo, e inspeccionar exactamente qué hizo cada ejecución
después. Ninguna de las herramientas de prueba aprovisiona nada.

## Probar conexión

En una conexión, **Probar conexión** lanza una única consulta de **solo lectura** para confirmar que
lazyit puede llegar al sistema y autenticarse. Realiza una solicitud autenticada a la URL base de la
conexión (o a una **Ruta de comprobación** opcional que definas, p. ej. `/health`) e informa de si es
**Accesible** o **Fallida**, con el estado HTTP y la ruta consultada. **Nunca aprovisiona** — solo
comprueba la conectividad.

Algunos tipos de conexión no tienen nada que consultar en solo lectura: una **Tarea humana** no hace
ninguna llamada externa, y un **Webhook** es de solo escritura (un POST firmado), así que «Probar
conexión» te indica que no hay nada que consultar en lugar de enviar un evento real.

## Simulación (Ejecución de prueba)

Una **simulación** previsualiza las solicitudes que se harían y el recorrido que *tomaría* una
ejecución por el flujo, con una **concesión real** — pero **no se envía nada ni se aprovisiona nada**.
Úsala para confirmar tu mapeo de datos y tus aristas de éxito/fallo antes de activar el flujo.

- Elige una **Concesión de muestra** (una de las concesiones activas de la aplicación) contra cuyo
  contexto se resuelven las solicitudes. Si no hay concesiones activas, concede acceso a alguien
  primero para tener algo que muestrear.
- El resultado muestra el método, el destino, los **campos mapeados**, las cabeceras y el cuerpo de
  cada paso (con los secretos ocultos), y dónde terminaría la ejecución.
- Puedes **simular el fallo de un paso** para previsualizar la arista de fallo de ese paso (escalar /
  compensar / detener) sin que nada falle de verdad.

## La cronología de la ejecución

Cada ejecución real se registra. Abre una ejecución para ver su **Cronología**: cada paso en el orden
en que se ejecutó, su estado, el estado HTTP cuando aplica, el número de **intento** y la arista de
éxito/fallo que se tomó. Desde un paso puedes abrir sus **detalles de solicitud** (método, host de
destino y los nombres de los campos mapeados) y saltar a la **tarea manual** si la ejecución se pausó.

> **Qué se registra — y qué no.** Por privacidad y seguridad, los **cuerpos de solicitud y respuesta
> no se capturan, por diseño.** Una ejecución registra únicamente el método, el host de destino, los
> *nombres* de los campos mapeados (no sus valores) y un resultado a grandes rasgos. Los secretos
> nunca se registran.

La pestaña Flujos de trabajo de la aplicación también muestra las **Ejecuciones recientes**, y cada
concesión lleva una pequeña etiqueta — **Aprovisionado**, **Aprovisionando…** o **Requiere
atención** — para que veas de un vistazo si la automatización de una concesión se completó.

## Reintentar y volver a ejecutar una ejecución fallida

Cuando una ejecución termina **Fallida**, tienes dos acciones de recuperación (ambas requieren el
permiso **`workflow:run`**):

- **Reintentar** — reanudar la **misma ejecución**, desde el paso que falló, sobre la **versión a la
  que estaba fijada**. Úsalo ante un problema transitorio (el sistema externo estuvo brevemente caído)
  cuando el flujo en sí es correcto. Opcionalmente puedes **Reintentar con ajustes** para indicar un
  valor puntual de un campo del paso fallido — el ajuste se aplica *solo a ese intento*, nunca se
  guarda y no edita el flujo.
- **Repetir con la última versión** — iniciar una ejecución **totalmente nueva** sobre la versión
  **actual** del flujo para la misma concesión, desde el primer paso. Úsalo *después de corregir el
  flujo*, porque un Reintentar normal repite la versión antigua fijada y no puede tomar tus cambios.

> **Repetir está protegido.** Si la ejecución fallida ya completó un paso no reversible (no
> idempotente), lazyit **se niega a repetir** — una ejecución nueva crearía esa cosa dos veces. En ese
> caso, vuelve a otorgar el acceso en su lugar.

## Cómo se reintentan los fallos transitorios

Cuando un paso tiene activado **Reintentar al fallar**, lazyit reintenta solo los fallos
**transitorios** — tiempos de espera agotados, cortes de red y respuestas HTTP **5xx** — con los
intentos y la espera que hayas elegido. Un HTTP **4xx** es un error permanente (solicitud incorrecta,
no autorizada, no encontrada) y **nunca se reintenta**, porque reintentarlo no ayudaría; el paso toma
su arista **Al fallar** en su lugar.

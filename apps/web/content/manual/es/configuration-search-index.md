---
title: Índice de búsqueda
category: configuration
subcategory: search-index
order: 6
---

# Índice de búsqueda

La búsqueda global de lazyit (la paleta de comandos **⌘K** en la barra superior) funciona con un motor
de búsqueda dedicado que mantiene un **índice** aparte de tus datos, tolerante a errores de tecleo. El
índice abarca activos, artículos, usuarios, ubicaciones y aplicaciones. Esta página explica cómo se
mantiene sincronizado el índice y qué hacer cuando se desfasa.

## Cómo se mantiene actualizado el índice

Normalmente no tienes que pensar en el índice — lazyit lo mantiene al día por ti:

- **Sincronización en vivo.** Cuando se crea, actualiza o elimina un registro, lazyit actualiza el
  índice en segundo plano. Esto es deliberadamente **tolerante a fallos**: si el motor de búsqueda no
  está disponible un momento, tu escritura igualmente se completa — la búsqueda solo se retrasa hasta
  que el índice se pone al día.
- **Autorreparación al arrancar.** Cuando la aplicación arranca, comprueba cada índice y reconstruye
  automáticamente cualquiera que falte o esté vacío. No hace nada cuando los índices ya tienen datos,
  así que es seguro en un parque grande.
- **Reconciliación periódica.** Un proceso en segundo plano reconstruye periódicamente los índices a
  partir de la base de datos para reparar cualquier desfase por una actualización en segundo plano que
  se haya perdido. La frecuencia es cada hora por defecto y un operador puede ajustarla.

> Solo se indexan los artículos de la base de conocimiento **publicados**, así que el contenido de un
> borrador no puede aparecer en la búsqueda. Los registros borrados de forma lógica se quitan del
> índice, así que nunca aparecen en los resultados.

## Cuando la búsqueda no devuelve nada

Si la búsqueda global no muestra resultados, distingue dos casos:

- **"Búsqueda no disponible".** El motor está caído o inaccesible. La búsqueda se degrada con elegancia
  y te lo indica, en lugar de fingir que no hay coincidencias. Suele resolverse solo cuando el motor
  vuelve; si persiste, comprueba que el servicio de búsqueda está en marcha. Consulta
  [Servicios](/help/deployment-operations-services).
- **Resultados realmente vacíos, sobre todo justo después de desplegar.** Una instancia recién
  desplegada o recién sembrada puede arrancar con los índices vacíos. La autorreparación al arrancar
  cubre un índice totalmente vacío, pero la solución fiable es una reindexación completa.

## Reindexar

Una **reindexación completa** reconstruye todos los índices a partir de la base de datos. Es la
reparación determinista para cualquier desfase y el paso esperado tras un primer despliegue. Se ejecuta
desde el servicio de la API:

```
bun run reindex:all
```

Ejecútalo una vez en el primer despliegue para rellenar el índice, y cada vez que sospeches que la
búsqueda está desfasada (por ejemplo tras restaurar una copia de seguridad o tras una caída prolongada
del motor de búsqueda). La reconstrucción es sin tiempo de inactividad — la búsqueda sigue sirviendo el
índice antiguo hasta que el nuevo se intercambia.

> La reindexación lee de tu base de datos existente y solo escribe en el índice de búsqueda; nunca
> cambia tus registros. Siempre es seguro ejecutarla.

## Salud del índice, de un vistazo

- Los registros nuevos y modificados aparecen en la búsqueda en cuestión de momentos — si no, el motor
  puede estar caído.
- Tras un despliegue, una restauración o una caída larga, ejecuta `reindex:all` para garantizar un
  índice completo.
- "Búsqueda no disponible" se refiere al motor, no a tus datos — tus registros están intactos y las
  escrituras siguen funcionando.

Para ejecutar y supervisar el propio servicio de búsqueda, consulta
[Servicios](/help/deployment-operations-services) y
[Solución de problemas](/help/deployment-operations-troubleshooting).

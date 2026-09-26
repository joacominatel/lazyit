---
title: Asistente de IA — resolución de problemas
order: 1
category: ai-assistant
subcategory: troubleshooting
---

# Asistente de IA — resolución de problemas

Cada entrada va **síntoma → causa → solución**. Los mensajes se citan como los muestra lazyit en
español; la interfaz en inglés dice lo mismo en inglés. Los errores nunca incluyen la respuesta propia
del proveedor — lazyit la deja afuera a propósito, para que ni la clave ni tus datos terminen en un
mensaje o en un log.

## Configurar el asistente

### La prueba de conexión falla

La prueba del asistente de configuración y de **Proveedor y modelo** comprueba la clave, el modelo y la
llamada a herramientas.

| La prueba dice | Causa | Solución |
| --- | --- | --- |
| El proveedor rechazó la clave | Clave equivocada, revocada o inactiva, o una clave que no puede usar este modelo. | Creá o revisá la clave en el proveedor y escribila de nuevo. |
| El proveedor está limitando esta clave | Demasiados pedidos con esta clave en este momento. | Esperá un momento y probá de nuevo. |
| No se pudo contactar al proveedor o no respondió a tiempo | La ruta de red desde el servidor de la API, un firewall o una caída del proveedor. | Comprobá que el contenedor de la API llegue al proveedor por HTTPS y probá de nuevo. |
| El proveedor rechazó el pedido | Casi siempre un id de modelo desconocido, o un ajuste que el modelo no soporta (esfuerzo o temperatura). | Revisá el id del modelo en el proveedor; borrá los ajustes extra. |
| lazyit se negó a conectarse a esta dirección | La URL base no es un host público, o es privada y **Servidor en una red privada** está desactivado — o es de loopback, link-local o de metadatos de la nube, que nunca se permiten. | Activá **Servidor en una red privada** para un servidor de la LAN; usá la dirección del servidor en tu red, nunca `localhost`. Mirá [Servidores en red privada](/help/ai-assistant-setup#servidores-en-red-privada). |
| El modelo respondió pero no llamó a ninguna herramienta | El modelo no llama herramientas, o el servidor lo tiene deshabilitado. | Elegí un modelo con llamada a herramientas (en un servidor propio, habilitala en su configuración). |
| Esta versión de lazyit no puede contactar proveedores de IA | La instancia es anterior al asistente. | Actualizá lazyit. |

### La página dice "El servidor no tiene AI_SECRET_KEY"

**Causa:** la API no tiene `AI_SECRET_KEY`, así que no se puede guardar ninguna clave de proveedor.
**Solución:** configurala (`openssl rand -hex 32`) y reiniciá la API — mirá
[Antes de empezar](/help/ai-assistant-setup#antes-de-empezar-ai_secret_key). Un servidor compatible con
OpenAI sin clave funciona igual.

Si la clave **cambió** (por ejemplo, al restaurar un archivo de entorno de otro host), la clave del
proveedor guardada ya no se puede descifrar y el asistente deja de estar disponible. Escribí de nuevo la
clave del proveedor en **Proveedor y modelo**.

### El asistente no se puede activar

| Mensaje | Causa | Solución |
| --- | --- | --- |
| Acepta qué sale de este servidor… | La casilla de divulgación del último paso no está marcada. | Leela y marcala. |
| Al cambiar el proveedor o la URL base se descartó la clave guardada… | Una clave pertenece a un único destino. | Escribí la clave del proveedor o la URL nuevos en el mismo guardado. |
| La prueba de conexión falló, así que no se cambió nada | lazyit vuelve a probar al activar. | Corregí lo que dice el resultado de la prueba (tabla de arriba). |
| Esta instancia funciona con la autenticación desactivada (AUTH_MODE=shim) | Un modo de desarrollo donde la IA nunca está disponible. | Ejecutá la instancia con un modo de inicio de sesión real. |
| Otra persona cambió la configuración de IA mientras tanto | Dos administradores guardaron a la vez. | Recargá y guardá de nuevo. |

### La búsqueda web está deshabilitada en el proveedor

**Síntoma:** con **Permitir que el asistente busque en la web** activado, los chats fallan con *"El
proveedor de IA rechazó la búsqueda web porque está deshabilitada para esta cuenta."*

**Causa:** tu cuenta en el proveedor tiene la búsqueda web desactivada de su lado (Anthropic: la
configuración de privacidad de la organización en la Claude Console; OpenAI: los permisos de
herramientas de la organización o del proyecto).

**Solución:** habilitá la búsqueda web en el proveedor — o desactivá el interruptor en **Configuración →
IA**. Los chats que tenían búsqueda web quedan de solo lectura; se empieza un chat nuevo.

Si el **interruptor está deshabilitado**, la tarjeta dice por qué: el proveedor no tiene búsqueda web
nativa (compatible con OpenAI) o el modelo no puede buscar junto con las herramientas de lazyit (Gemini
anterior a 3).

## El chat

### El chat no aparece

- El asistente está desactivado — un administrador lo activa en **Configuración → IA**.
- Tu rol no tiene **Usar el asistente de IA** — mirá [Permisos](/help/permissions).
- Se acaba de activar — aparece en menos de un minuto, o recargá la página.

### Mensajes del chat

| El chat dice | Causa | Solución |
| --- | --- | --- |
| El proveedor de IA rechazó las credenciales | La clave guardada se revocó o venció en el proveedor. | Un administrador escribe una clave nueva en **Configuración → IA**. |
| El proveedor de IA está ocupado | El proveedor está limitando pedidos (tu clave o su propia carga). | **Reintentar** después del tiempo indicado. |
| El proveedor de IA no responde en este momento | Caída, problema de red o una respuesta muy lenta. | **Reintentar**; si sigue, revisá la página de estado del proveedor y la ruta de red de la API. |
| El proveedor de IA no pudo procesar este pedido | El proveedor rechazó el pedido — a menudo un modelo que ya no ofrece, o uno que la persona escribió y no existe. | Empezá un chat nuevo con otro modelo; un administrador revisa el modelo por defecto. |
| El proveedor de IA se negó a responder esto | El filtro de contenido del propio proveedor frenó la respuesta. | Reformulá el pedido. |
| lazyit no tiene permitido conectarse con el proveedor de IA | Las reglas de red de lazyit rechazan la dirección del proveedor. | Un administrador revisa la URL base y **Servidor en una red privada**. |
| El proveedor de IA rechazó la búsqueda web porque está deshabilitada para esta cuenta | Mirá [La búsqueda web está deshabilitada en el proveedor](#la-búsqueda-web-está-deshabilitada-en-el-proveedor). | |
| Se alcanzó el presupuesto diario de IA | Usaste tus tokens de las últimas 24 horas. | Esperá, o pedile a un administrador que suba el presupuesto. |
| Esta conversación es demasiado larga para continuar | La conversación llegó al tamaño máximo. | **Empezar un nuevo chat**. |
| El asistente se detuvo después de demasiados pasos | El pedido necesitó más llamadas a herramientas que las que permite **Pasos máximos por pedido**. | Dividilo en pedidos más chicos, o un administrador sube el límite. |
| Este chat usó una configuración de IA anterior y es de solo lectura | Mirá [Este chat es de solo lectura](#este-chat-es-de-solo-lectura). | **Empezar un nuevo chat**. |
| Otra ventana ya está respondiendo en este chat | El chat está abierto en otra pestaña o dispositivo. | El chat muestra esa respuesta; esperala. |
| Se perdió la conexión | El navegador perdió la conexión con lazyit. | **Reconectar**. La respuesta siguió en el servidor. |
| La respuesta se interrumpió por un reinicio | La API se reinició a mitad de la respuesta. | Mandá el mensaje de nuevo. |
| Demasiados pedidos | Mandaste muchos mensajes en poco tiempo. | Esperá un momento. |
| Se desactivó el asistente de IA | Un administrador lo desactivó. | Nada que hacer; los cambios pendientes no se pueden aprobar. |
| Ya no tenés acceso al asistente | Tu rol perdió **Usar el asistente de IA**, o tu cuenta cambió. | Consultá a un administrador. |

### Este chat es de solo lectura

Un chat deja de aceptar mensajes cuando un administrador cambió el proveedor o el modelo por defecto que
usaba, desactivó la búsqueda web que tenía, cuando lazyit se actualizó con otras herramientas o
instrucciones, o cuando se hizo demasiado largo. Lo podés leer y copiar (`/copy`); elegí **Empezar un
nuevo chat** para seguir.

### Las respuestas aparecen de golpe, no mientras se escriben

**Causa:** un proxy inverso o balanceador **delante del Caddy de lazyit** bufferea o comprime el stream
de eventos del chat. **Solución:** desactivá el buffer y la compresión para `text/event-stream` en ese
proxy (nginx: `proxy_buffering off;` en la location de lazyit). Mirá
[Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls).

### El asistente abandona algo que intentó dos veces

**Causa:** cuando la misma llamada a una herramienta falla dos veces igual en una respuesta, lazyit se
niega a ejecutarla otra vez y le indica al asistente que pare y explique qué lo bloquea, en vez de
quedarse en un bucle. **Solución:** leé lo que dice — suele ser un registro que falta, un permiso que no
tenés o un dato que necesita de vos — y respondé o reformulá.

## Tarjetas de cambio

### "El elemento cambió después de la propuesta"

**Causa:** alguien editó el registro entre la propuesta y tu aprobación. No se aplicó nada.
**Solución:** no hace falta nada — el asistente lo vuelve a leer y puede proponer un cambio actualizado.

### "Este cambio se actualizó después de proponerse"

**Causa:** los efectos del cambio ahora son otros — se sumó un aviso, o cambió un número de impacto (más
activos usan ahora la categoría que afectaría un archivo). No se aplicó nada. **Solución:** revisá los
puntos marcados **Nuevo** y decidí de nuevo. Mirá
[Cuando la tarjeta cambia mientras decidís](/help/ai-assistant-approvals#cuando-la-tarjeta-cambia-mientras-decidís).

### "Demasiadas contraseñas incorrectas. Probá de nuevo en …"

**Causa:** cinco contraseñas incorrectas seguidas. lazyit bloquea los intentos por un tiempo que crece
con cada fallo, de un segundo hasta 15 minutos. La cuenta es compartida entre las tarjetas del chat y la
pantalla de consentimiento de MCP. **Solución:** esperá el tiempo indicado; el botón **Aprobar** vuelve
solo.

### "La confirmación con contraseña no está disponible con tu forma de iniciar sesión"

**Causa:** tu cuenta inicia sesión con tu proveedor de identidad, sin contraseña de lazyit.
**Solución:** hacé ese cambio desde la página del elemento.

### "5 cambios no se pudieron proponer" (u otro número)

**Causa:** como máximo 5 cambios pueden esperar aprobación en un paso; el resto se retiene a propósito.
**Solución:** decidí los actuales — el asistente propone la tanda siguiente solo. Otros motivos aparecen
en **Ver detalles** (un valor inválido, un permiso que no tenés).

### Aprobar todos saltea algunos cambios

**Causa:** por diseño, nunca incluye cambios que piden tu contraseña, *Cambios sensibles* ni cambios
cuya última decisión fue rechazada. **Solución:** decidilos en su propia página. Mirá
[Varios cambios a la vez](/help/ai-assistant-approvals#varios-cambios-a-la-vez).

### Un cambio no se aprobó automáticamente

**Causa:** la aprobación automática nunca cubre cambios críticos, cambios propuestos después de que el
asistente leyó texto libre en el mismo turno (de cualquiera, incluidas tus propias notas), ni nada en un
chat que buscó en la web. **Solución:** aprobalo en su tarjeta. Mirá
[Aprobación automática](/help/ai-assistant-approvals#aprobación-automática).

## Agentes de IA externos (MCP)

### Conectar un cliente

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `/mcp` responde 404 | Agentes de IA externos (MCP) está desactivado, o la instancia corre en modo shim. | Un administrador lo activa en **Configuración → IA**. |
| 401 *"This instance uses OAuth for AI agents: personal tokens are not accepted"* | Un token personal en una instancia HTTPS (o una que pasó de modo LAN a HTTPS). | Sacá la cabecera y dejá que el cliente inicie sesión. |
| En una instancia HTTP plana, Claude Code muestra el servidor como `failed` o *needs authentication* | No hay token personal configurado — en HTTP plano no hay OAuth. | Activá el plugin y pegá un [token personal](/help/ai-assistant-connected-apps#tokens-personales), o agregá el servidor con `--header "Authorization: Bearer lzit_pat_…"`. Para una sesión por script, pasalo con `--settings '{"pluginConfigs":{"lazyit@skills-dir":{"options":{"token":"lzit_pat_…"}}}}'` (ojo con el historial de tu shell). |
| Claude Code sigue diciendo *needs authentication* después de agregar la cabecera | Claude Code guarda ese estado por nombre de servidor. | `claude mcp remove lazyit` y agregalo de nuevo — o autenticá desde `/mcp`. |
| Claude Code muestra `failed` en una instancia HTTPS con una CA de la empresa | Node.js no confía en tu autoridad certificante. | Arrancalo con `NODE_EXTRA_CA_CERTS=/ruta/a/ca-interna.pem`. |
| `claude plugin install` falla: *"Archive URLs must use https:// and must not point at a loopback…"* | La dirección de la instancia es `localhost`. | [Instalá desde una descarga](/help/ai-assistant-claude-code-mcp#instalar-desde-una-descarga-cualquier-instancia) o usá un nombre de host real. |
| **IA y apps conectadas** dice HTTPS pero usa tokens personales | `WEB_ORIGIN` no es una dirección `https://`. | Un administrador lo configura y reinicia la API. |
| claude.ai, los conectores de Claude Desktop o ChatGPT no se pueden conectar | Se conectan desde los servidores del proveedor. | La instancia tiene que ser accesible desde internet por HTTPS con un certificado de confianza pública. |
| 400 *"Send the token in the Authorization header, never in the URL."* | El token se puso en la dirección, así que lazyit lo revocó. | Creá un token nuevo y mandalo en la cabecera. |
| En HTTP plano, un cliente falla con *Unexpected token '<'* | Intentó OAuth, y la configuración del proxy de la instancia es anterior al arreglo que responde esas consultas con un error limpio. | Usá un token personal; actualizá lazyit para obtener un error claro. |
| Las respuestas de un cliente viejo vencen detrás de tu propio proxy | Un proxy delante de Caddy bufferea `text/event-stream`. | No buferees ni comprimas los streams de eventos en ese proxy. |

### La pantalla de consentimiento dice que la app no está permitida

| La pantalla dice | Causa | Solución |
| --- | --- | --- |
| **Esta app no está permitida** | La app no está registrada o no está en la lista de permitidas: un callback con esquema de app o de loopback que no está en la lista, **Aceptar cualquier cliente con callback https://** desactivado, o un cliente incluido que un administrador quitó. | Empezá la conexión de nuevo desde la app; si no, un administrador [agrega el cliente](/help/ai-assistant-setup#clientes-permitidos) por su URL de metadatos o su dirección de callback. |
| **No se puede confiar en esta solicitud** | La app pidió mandarte a una dirección que no registró. | Empezá de nuevo desde la app. Si se repite, el callback de la app no es el de la lista. |
| **El inicio de sesión de apps no está disponible aquí** | La instancia no tiene un `WEB_ORIGIN` HTTPS. | Usá un token personal. |
| **Las conexiones de apps de IA están desactivadas** | MCP está desactivado. | Un administrador lo activa. |
| **Tu cuenta no puede conectar apps de IA** | Tu rol no tiene **Conectar agentes de IA externos (MCP)**. | Consultá a un administrador. |

Un cliente que se registra solo (la mayoría) y es rechazado muestra lo mismo: su registro falla con
`invalid_redirect_uri` cuando su callback no está permitido. El MCP Inspector, por ejemplo, necesita que
un administrador agregue su callback fijo.

**Una app que se identifica con una dirección HTTPS** necesita que lazyit pueda descargar esa dirección.
Sin acceso a internet en el servidor, solo Claude Code se sigue conectando (lazyit trae una copia de su
descripción); las demás apps de ese tipo se rechazan hasta que el servidor pueda llegar a ellas. lazyit
además limita cuántas de esas descargas puede provocar una persona en poco tiempo.

### "Demasiados intentos" en la pantalla de consentimiento

**Causa:** contraseñas incorrectas para **Acciones de administración**; el bloqueo es compartido con las
confirmaciones con contraseña del chat. **Solución:** esperá y probá de nuevo, o desmarcá **Acciones de
administración** y permití el resto.

### Se desmarcaron las acciones de administración

**Causa:** tu cuenta inicia sesión sin contraseña de lazyit, así que las acciones de administración no
se pueden otorgar. **Solución:** permití el resto; hacé los cambios de nivel administrador vos mismo en la
app.

### Una app conectada dejó de funcionar

Revisá, en orden: la revocaste; tu contraseña cambió o se restableció (termina todas las conexiones); tu
cuenta se desactivó; se desactivó MCP (las conexiones quedan en pausa); venció un token personal; una
app OAuth pasó 30 días sin usarse; la instancia pasó de HTTP plano a HTTPS (los tokens personales dejan
de funcionar). Mirá [Qué termina una conexión](/help/ai-assistant-connected-apps#qué-termina-una-conexión).
Cerrar sesión en lazyit **no** es una causa.

### La ejecución de una cuenta de servicio se detiene en su tope de escrituras

**Causa:** **Limitar escrituras**, en el acceso a IA de la cuenta, cuenta cada registro modificado; un
lote más grande que lo que queda se rechaza entero. **Solución:** subí el tope, o hacé que el script
mande lotes más chicos. Mirá [Cuentas de servicio](/help/ai-assistant-setup#cuentas-de-servicio).

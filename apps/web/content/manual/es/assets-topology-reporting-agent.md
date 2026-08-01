---
title: Agente de reporte
category: assets
subcategory: topology
order: 3
---

# Agente de reporte

El **agente de reporte** completa tu inventario por vos. Es un programa pequeño que instalás en un
servidor Linux con un solo comando; a partir de ahí el servidor reporta *qué es* — su hardware y el
software instalado — a lazyit y mantiene esa imagen actualizada, así no tenés que cargarla ni
mantenerla a mano.

Es deliberadamente acotado. El agente reporta **solo inventario**: qué es un host y qué ejecuta,
nunca métricas, alertas ni datos de series temporales. lazyit es un CMDB, no una herramienta de
monitoreo. El agente descubre **solo el host donde se ejecuta** — no hay escaneo de red. Para cubrir
más servidores, lo instalás en más servidores.

> El agente solo **agrega propuestas**. Un host recién descubierto llega a la bandeja de **Revisión
> pendiente** como propuesta — nunca modifica tu inventario activo hasta que una persona lo confirma.

## Creá tu primer agente

En la vista **Servidores** (la vista Tabla de **Activos › Topología**), cuando todavía no tenés
agentes, aparece arriba una tarjeta **Creá tu primer agente**. Una vez que tenés agentes, se reduce a
un botón discreto **Agregar agente**. (Necesitás el permiso de gestión de configuración para usarlo,
porque crea un token.)

El botón abre un asistente guiado y breve, de tres pasos:

1. **Nombre y generación.** Poné un nombre que reconozcas más adelante (por ejemplo el nombre del
   servidor, como `web-prod-01`) y hacé clic en **Generar credenciales**. lazyit crea una cuenta de
   servicio limitada **únicamente** al permiso `infra:report`.
2. **Instalación.** lazyit te muestra un **comando de instalación** listo para pegar con el token ya
   incluido:

   ```sh
   curl -fsSL https://tu-instancia/install.sh | sudo sh -s -- --url https://tu-instancia --token <token>
   ```

   La dirección es **tu propia instancia de lazyit** — el agente solo se comunica con el servidor que
   vos ejecutás, y tiene que ser el **origen HTTPS público** (la dirección que usás en el navegador,
   delante del proxy reverso) — **nunca** el puerto crudo del web (`:3000`), que no tiene ruta para la
   descarga del agente y hará que la instalación falle. Ejecutalo en un servidor **Linux** **como
   root**. El token se muestra **una sola vez**, así que copialo (o descargalo) antes de continuar. Si
   preferís revisar cada paso, expandí **Instalar manualmente (paso a paso)** para la misma instalación
   hecha a mano (descargar el binario, instalarlo, escribir el archivo de configuración y enviar un
   reporte de prueba).

   > **¿Despliegue en LAN (sin dominio público)?** Si tu instancia solo es alcanzable por una IP o
   > nombre de host de LAN con un certificado autofirmado, confiá en esa autoridad certificadora en el
   > host del agente **antes** de correr el comando de instalación, o la descarga se rechazará por no
   > ser confiable. Consultá el runbook de despliegue LAN de tu instalación para el helper de una línea
   > que hace esto.
3. **Espera.** El asistente entonces espera a que el servidor reporte. Apenas el agente reporta —
   normalmente en un par de minutos — muestra un mensaje de éxito y un botón **Confirmar** en línea.
   Podés confirmar ahí mismo, o cerrar el asistente y confirmarlo más tarde desde la bandeja de
   Revisión pendiente.

### Instalar manualmente (paso a paso)

La sección plegada **Instalar manualmente** del asistente da la misma instalación comando por comando,
para un administrador cauteloso que prefiere descargar e inspeccionar el binario primero. Cada paso
tiene su propio botón de copiar:

1. **Descargá el binario** (usá `arch=arm64` en máquinas ARM):

   ```sh
   curl -fsSL -H "Authorization: Bearer <token>" "https://tu-instancia/api/agent/download?arch=x64" -o lazyit-agent
   ```
2. **Hacelo ejecutable y movelo a su lugar:**

   ```sh
   chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/
   ```
3. **Creá el archivo de configuración** (contiene el token, así que `chmod 600`) con `LAZYIT_URL` y
   `LAZYIT_TOKEN` en `/etc/lazyit-agent/config`.
4. **Enviá un primer reporte** para verificar que funciona:

   ```sh
   sudo lazyit-agent report --once
   ```

## Revisión pendiente

Los hosts descubiertos no entran directo a tu inventario: te esperan en la bandeja de **Revisión
pendiente** arriba de la vista de Servidores, cada uno mostrando su nombre de host, su tipo, de dónde
vino el reporte y hace cuánto reportó por última vez. Para cada uno tenés dos opciones:

- **Confirmar** — suma el host a tu topología activa. Un diálogo breve te permite renombrarlo y
  cambiar su tipo antes, y ofrece un interruptor **Registrar como activo de inventario** (**activado**
  por defecto): si lo dejás activado, lazyit también crea un **activo** registrado con los datos
  reportados del host, así el servidor puede tener responsable, artículos de la base de conocimiento y
  referencias a secretos como cualquier otro activo. Si el host reportó un **número de serie** de
  hardware real, ese pasa a ser el serie del activo automáticamente (un texto de relleno como
  *"To be filled by O.E.M."*, o un serie que ya usa otro activo, se descarta). Desactivá el
  interruptor para dejar el nodo solo en el grafo.
- **Descartar** — elimina la propuesta. Es un borrado lógico (igual que quitar cualquier nodo del
  mapa): no se destruye nada y se puede restaurar más adelante. **Descartar no detiene al agente.**
  Si ese host todavía tiene el agente instalado y corriendo, su próximo reporte lo vuelve a informar
  y reaparece como una propuesta nueva. Para que deje de aparecer, desinstalá el agente en ese host
  — o revocá el token que usa.

Un host descubierto también **completa su propia dirección IP** apenas reporta: no hace falta que la
escribas. En cada reporte posterior la IP se actualiza al valor actual, **salvo que la hayas editado a
mano** en el nodo: una IP manual se considera tuya y el agente nunca la sobrescribe.

Una vez confirmado, un host sigue recibiendo datos frescos del agente, pero tus ediciones — su
nombre, tipo, posición, IP y conexiones — son tuyas y el agente nunca las sobrescribe. El inventario
reportado — sistema operativo, CPU, memoria, discos, interfaces de red, número de serie y software
instalado — se muestra como un panel de solo lectura **Datos reportados** en el propio nodo (abrí un
nodo en el diagrama o en la lista de Servidores), y los mismos datos aparecen en el activo
correspondiente. Ambos se mantienen frescos: cada reporte los actualiza sin tocar nada que sea tuyo
(el nombre, el número de serie y el modelo del activo nunca cambian por un reporte).

## Qué recopila el agente

- **Identidad y hardware** — nombre de host, sistema operativo y kernel, CPU y memoria, discos e
  interfaces de red y (solo cuando se ejecuta como root) fabricante / modelo / número de serie. Ahora
  también lee direcciones **IPv6**: la lista de interfaces sigue mostrando la IPv4 de cada una, pero un
  host que no tiene ninguna IPv4 por fin obtiene una dirección en el diagrama de infraestructura en vez
  de un vacío.
- **Qué tipo de máquina es** — servidor, escritorio, notebook, máquina virtual o contenedor, y la
  virtualización sobre la que corre (KVM, VMware, Hyper-V, Xen, LXC, Docker, WSL…) cuando puede
  determinarlo. Cuando *no* puede — la herramienta que necesita no está instalada — reporta
  **desconocido** en vez de adivinar, y lo aclara en las notas de abajo. lazyit lo guarda junto a los
  demás datos reportados del host; hoy no se muestra en la interfaz.
- **Cuándo arrancó por última vez** — una sola marca de tiempo, actualizada en cada reporte y sin
  histórico: es un dato de inventario ("¿este equipo realmente se reinició después de la ventana de
  parches?"), no monitoreo de uptime. Se guarda junto a los demás datos reportados del host y, igual
  que el tipo de máquina, todavía no se muestra en ninguna pantalla.
- **Software instalado** — la lista de paquetes instalados, con versiones cuando están disponibles. El
  agente además registra qué gestor de paquetes reportó cada uno; la lista en sí muestra el nombre y
  la versión.
- **Qué no pudo recopilar** — cada reporte también indica si corrió como root y nombra lo que tuvo que
  omitir o lo que agotó su tiempo. Si ejecutás el agente a mano (`lazyit-agent report --once`) imprime
  esas notas ahí mismo, que suele ser la forma más rápida de responder "¿por qué está vacía la columna
  de número de serie de este host?". lazyit además las guarda junto a los datos reportados del host,
  para que una futura vista de parque pueda responderlo para todo el estado; hoy no se muestran en la
  interfaz.

Recopila todo lo que puede y simplemente omite lo que no puede leer, así una instalación sin
privilegios igual reporta una imagen útil. **Nunca** lee secretos, archivos ni datos de aplicaciones,
y no envía métricas.

## Seguridad

- **Un permiso acotado.** El token tiene **solo** `infra:report`. No puede leer ni modificar nada más
  en lazyit — ni activos, ni secretos, ni otra infraestructura. Lo peor que puede hacer un token
  filtrado es crear propuestas que vos descartás.
- **Una compuerta humana.** Todo lo que el agente reporta queda como **Pendiente** y solo pasa a ser
  parte de tu inventario cuando lo confirmás. Un escritor automático nunca puede cambiar tus registros
  oficiales en silencio.
- **Nunca secretos.** El agente no lleva claves ni lee ninguna bóveda — los valores de tus secretos
  quedan intactos.
- **Autoalojado y compatible con redes aisladas.** El comando de instalación apunta a *tu* instancia,
  el agente solo se comunica con esa instancia y funciona totalmente sin conexión. Los tokens se pueden
  revocar en cualquier momento desde [Cuentas de servicio](/help/users-permissions-service-accounts).
- **Límites de reporte.** Cada token está limitado de dos formas: **cada cuánto** puede reportar (por
  defecto 120 veces por minuto) y **cuántos servidores recién descubiertos** puede agregar (por
  defecto 100 por hora). Juntos protegen tu base de datos de un agente descontrolado o robado — un
  token ya no puede llenarla de propuestas. Ambos valores por defecto asumen un parque de unos **100
  servidores** compartiendo un mismo token de instalación, así que un despliegue normal nunca los
  alcanza: los 100 servidores pueden descubrirse dentro de la primera hora. Dos cosas conviene saber.
  Un servidor que **ya confirmaste sigue reportando pase lo que pase**: alcanzar un límite solo
  demora los descubrimientos *nuevos*, nunca la disponibilidad ni el inventario de los servidores que
  ya tenés, así que no puede hacer que tu mapa muestre una caída falsa. Y **no hay que limpiar nada**
  para recuperarse: un agente rechazado simplemente tiene éxito en su próximo intento, en la ventana
  siguiente. Qué tan llena esté tu bandeja de Pendientes no afecta estos límites en absoluto. ¿Vas a
  desplegar más de 100 servidores de una vez? Dejá que se acomode en un par de horas, o subí
  `INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW` (y `INFRA_REPORT_MAX_PER_WINDOW`, los reportes permitidos
  por minuto) en el entorno de tu instancia y reiniciala.

## Mantener el agente al día

Cada agente estampa su propia versión en cada reporte. Cuando un agente queda una **versión mayor**
por detrás de tu servidor, su fila (y su panel de detalle) muestra una pequeña insignia **Agente
desactualizado** — un aviso para volver a ejecutar el comando de instalación y obtener el último
binario. Es solo un empujón: un agente desactualizado sigue reportando con normalidad, no se bloquea
nada, y las actualizaciones menores no la activan. Los agentes compilados desde el código fuente (o
anteriores al versionado) reportan como `dev` y nunca muestran la insignia.

**Actualizar tu instancia nunca rompe los agentes ya instalados.** No hace falta reinstalar nada: un
agente más viejo sigue reportando igual que antes, y cada dato que envía aterriza exactamente donde
aterrizaba.

**A partir de esta versión también vale el sentido inverso.** Un agente *más nuevo* que reporta a un
servidor más viejo es aceptado: el servidor toma todos los datos que entiende y simplemente anota los
que no, en vez de rechazar el reporte completo. Esa diferencia importa — un reporte rechazado haría
desaparecer al servidor de tu inventario y parecería una caída, mientras que un campo desactualizado
nunca lo hace. Ojo con el "a partir de esta versión": las instancias anteriores a esta release siguen
rechazando un reporte que mencione algo que no reconocen, así que si vas a correr agentes que se
actualizan por su cuenta, actualizá primero la instancia.

## Qué sigue

- [Diagrama de infraestructura](/help/assets-topology-diagram) — el mapa donde aparecen los servidores
  confirmados.
- [Lista de servidores](/help/assets-topology-servers) — la tabla donde vive la bandeja de Revisión
  pendiente.
- [Cuentas de servicio](/help/users-permissions-service-accounts) — gestioná o revocá el token del
  agente.

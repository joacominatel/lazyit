---
title: Agente de reporte
category: assets
subcategory: topology
order: 3
---

# Agente de reporte

El **agente de reporte** completa tu inventario por vos. Es un programa pequeño que instalás en una
máquina **Linux o Windows** con un solo comando; a partir de ahí esa máquina reporta *qué es* — su
hardware y el software instalado — a lazyit y mantiene esa imagen actualizada, así no tenés que
cargarla ni mantenerla a mano.

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

   En **Windows**, la misma instalación con el mismo token, desde una PowerShell **elevada**:

   ```powershell
   & ([scriptblock]::Create((irm https://tu-instancia/install.ps1))) -Url https://tu-instancia -Token <token>
   ```

   (La forma con bloque de script no es adorno: el pipe `irm … | iex` no puede pasar parámetros.)
   Ver **[Hosts Windows](#hosts-windows)** más abajo para qué hace esa instalación y qué necesita.

   La dirección es **tu propia instancia de lazyit** — el agente solo se comunica con el servidor que
   vos ejecutás, y tiene que ser el **origen HTTPS público** (la dirección que usás en el navegador,
   delante del proxy reverso) — **nunca** el puerto crudo del web (`:3000`), que no tiene ruta para la
   descarga del agente y hará que la instalación falle. Ejecutalo **como root** en Linux, o **como
   Administrador** en Windows. El token se muestra **una sola vez**, así que copialo (o descargalo)
   antes de continuar. Si
   preferís revisar cada paso, expandí **Instalar manualmente (paso a paso)** para la misma instalación
   hecha a mano (descargar el binario, instalarlo, escribir el archivo de configuración y enviar un
   reporte de prueba).

   > **Mantené el token fuera de la shell.** Tal como está escrito arriba, el token queda visible en
   > `ps` para cualquier usuario de esa máquina durante los pocos segundos que dura la instalación, y
   > queda en el historial de la shell de root. Si eso importa donde trabajás, dos formas equivalentes
   > lo evitan: poner el token en el entorno (`LAZYIT_TOKEN=… sh install.sh --url …`), o en un archivo
   > y pasar `--token-file /root/agent.token`. Para cualquiera de las dos hay que descargar el script
   > primero. (`--token-file -` lo lee de una tubería, y por eso no puede combinarse con
   > `curl … | sh`: la tubería ya es la entrada del script.)

   > **¿Despliegue en LAN (sin dominio público)?** Si tu instancia solo es alcanzable por una IP o
   > nombre de host de LAN con un certificado autofirmado, copiá el `.pem` de esa autoridad
   > certificadora al host del agente y pasá **`--ca-file /ruta/al/ca.pem`**. El instalador lo usa
   > para su propia descarga *y* lo registra para que el agente lo use en cada reporte — **no** hace
   > falta confiar en esa autoridad a nivel de todo el sistema, que sería un cambio mucho más grande
   > en la máquina que "un agente de inventario habla con un servidor". Confiar en ella a nivel
   > sistema sigue funcionando si tu flota ya está armada así.

   > **¿Detrás de un proxy de salida?** No hace falta pasar nada al instalar; agregá `HTTPS_PROXY` (y
   > `NO_PROXY` si tu instancia es interna) a `/etc/lazyit-agent/config` después. Tiene que ir **ahí**,
   > no en `/etc/environment` ni en un perfil de shell: el agente corre desde un timer de systemd, y un
   > timer no hereda el entorno de sesión de la máquina — por eso un agente puede funcionar cuando lo
   > ejecutás a mano y quedarse callado en su propio horario. La forma en minúsculas (`https_proxy`,
   > `no_proxy`) también funciona, y gana si escribís las dos, igual que las lee `curl`. Lo que pongas
   > en ese archivo es la respuesta **completa** del agente: un `NO_PROXY` ahí sí frena un proxy que la
   > máquina haya definido en otro lado, en vez de perder contra él. Reinstalar conserva esas líneas,
   > en cualquiera de las dos formas.
3. **Espera.** El asistente entonces espera a que el servidor reporte. Apenas el agente reporta —
   normalmente en un par de minutos — muestra un mensaje de éxito y un botón **Confirmar** en línea.
   Podés confirmar ahí mismo, o cerrar el asistente y confirmarlo más tarde desde la bandeja de
   Revisión pendiente.

### Instalar manualmente (paso a paso)

La sección plegada **Instalar manualmente** del asistente da la misma instalación comando por comando,
para un administrador cauteloso que prefiere descargar e inspeccionar el binario primero. Cada paso
tiene su propio botón de copiar:

1. **Descargá el binario** (usá `arch=arm64` en máquinas ARM; agregá `&os=windows` para un host
   Windows, que entrega `lazyit-agent-windows-x64.exe`):

   ```sh
   curl -fsSL -H "Authorization: Bearer <token>" "https://tu-instancia/api/agent/download?os=linux&arch=x64" -o lazyit-agent
   ```

   La parte `os` es nueva. Los comandos de instalación anteriores, que piden `?arch=x64` sin `os`,
   siguen funcionando y siguen recibiendo la compilación de Linux: no hace falta volver a ejecutar
   nada de lo que ya instalaste.
2. **Hacelo ejecutable y movelo a su lugar:**

   ```sh
   chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/
   ```
3. **Creá el archivo de configuración** (contiene el token, así que `chmod 600`) con `LAZYIT_URL` y
   `LAZYIT_TOKEN` en `/etc/lazyit-agent/config`.
4. **Enviá un primer reporte** para verificar que funciona:

   ```sh
   sudo lazyit-agent report --once --force
   ```

### Qué necesita un host para ejecutarlo

En **Linux**: una máquina con **systemd** y **curl**, en x86-64 o ARM64.

En **Windows**: Windows 10/11 o Windows Server 2016 o posterior, en **x64** (no hay compilación
ARM64). La única dependencia es **PowerShell**, que viene con el sistema operativo — **no** necesitás
Node, Python ni ninguna otra cosa instalada.

En ambos, el agente es un único binario autocontenido: sin runtime, sin paquetes, nada que instalar
al lado.

Hay un piso de qué tan viejas pueden ser las bibliotecas del sistema y el kernel de la máquina, y en
vez de imprimir un número de versión que quedaría desactualizado, **el instalador prueba ejecutar el
binario antes de configurar nada**. Si la máquina no puede arrancarlo, obtenés una sola frase clara,
no se instala nada y no se arma ningún timer — en lugar de un host que parece estar bien y en silencio
nunca reporta.

En x86-64 hay dos builds y el instalador elige entre ellos leyendo la propia lista de capacidades de
la CPU: el habitual necesita un conjunto de instrucciones de 2013 o posterior, y las máquinas más
viejas — o los clústeres VMware configurados para presentar una CPU más antigua a sus invitados —
reciben automáticamente un build **baseline**. Esto importa más de lo que parece: una máquina virtual
puede funcionar sin problemas durante meses y empezar a fallar en el momento en que migra a hardware
más viejo. `--baseline` lo fuerza si preferís no depender de la detección.

### Revisar un host sin esperar un reporte

Dos comandos responden las dos preguntas que realmente vas a tener, y **ninguno de los dos envía ni
cambia nada**:

```sh
sudo lazyit-agent test    # ¿este host llega a lazyit, y su token sirve?
sudo lazyit-agent show    # ¿qué reportaría exactamente este host?
```

En Windows, los mismos dos comandos, desde una PowerShell elevada:

```powershell
& "$env:ProgramFiles\lazyit-agent\lazyit-agent.exe" test
& "$env:ProgramFiles\lazyit-agent\lazyit-agent.exe" show
```

**`test`** verifica la dirección, el DNS, el TLS, el proxy, la autoridad certificadora y el token, y
te dice cuál está mal: una redirección significa que apuntaste al puerto equivocado, un rechazo
significa el token, un timeout significa la red, y una dirección que responde pero no es lazyit se
informa exactamente como eso, en vez de pasar. (Pregunta dos veces a propósito: una sin tu token,
para confirmar que la dirección es realmente una instancia de lazyit que exige uno, y otra con él.
Las dos son lecturas.) También imprime cada cuánto está configurado este
host para reportar, cuándo lo logró por última vez y si el próximo tick reportaría — que suele ser la
respuesta a "este servidor se quedó callado". No escribe nada en el host ni en lazyit: no aparece
ninguna propuesta, ningún servidor queda marcado como recién reportado, y no se cuenta nada contra el
límite de reportes del token.

**`show`** imprime el reporte completo como JSON, sin enviarlo. Es la forma más rápida de responder
"por qué está vacía la columna de número de serie de este host" o "por qué no aparece este disco": las
notas del final dicen qué tuvo que omitir el agente y por qué. Funciona en una máquina sin token y sin
red alguna.

## Hosts Windows

Todo lo anterior también aplica a Windows: mismo asistente, mismo token, misma Revisión pendiente,
misma pantalla de configuración. Esta sección es solo sobre lo que *cambia*, y sobre las preguntas
que aparecen la primera vez.

### Qué hace realmente la instalación

Se ejecuta desde una PowerShell **elevada** (clic derecho en PowerShell → *Ejecutar como
administrador*). El instalador:

1. verifica que esté elevado y que la máquina sea x64;
2. descarga el ejecutable desde **tu** instancia con tu token, y rechaza cualquier cosa que no sea un
   ejecutable de Windows real — la misma protección que el instalador de Linux aplica a su binario;
3. compara la **huella** que tu instancia publica para ese ejecutable y rechaza una que no coincida;
4. **lo ejecuta una vez** (`--help`) antes de registrar nada: si la máquina no puede arrancarlo,
   obtenés una sola frase clara, no se instala nada y no se registra ninguna tarea;
5. escribe `C:\ProgramData\lazyit-agent\config` y lo restringe a **SYSTEM y Administradores
   únicamente** — el equivalente en Windows del `chmod 600` que usa en Linux, porque ese archivo
   contiene un token real;
6. registra una **tarea programada** y envía un reporte, para que sepas de inmediato si el token
   funciona.

### ¿Tengo que configurar algo?

No. **Administrador para instalar, y nada más.** La tarea corre como **`NT AUTHORITY\SYSTEM`**, que ya
tiene los permisos locales necesarios para leer el hardware, la red y el software instalado de la
máquina — **sin ninguna contraseña guardada en el host**. Justamente por eso *no* usa una cuenta de
servicio de dominio: eso significaría una credencial que funciona, en un archivo, en cada máquina del
parque.

Ejecutar el agente a mano **sin** Administrador también funciona: simplemente reporta menos (por
ejemplo, sin número de serie), igual que en Linux sin root, y `lazyit-agent show` te dice qué tuvo
que omitir.

### Una tarea programada, no un servicio

El agente es un programa de una sola pasada: corre, recolecta, reporta y termina. En Windows eso es
una **tarea programada** (`lazyit-agent` en el Programador de tareas), no un servicio de Windows.
Corre cada **5 minutos**, recupera un ciclo perdido mientras la máquina estuvo apagada y **funciona
con batería**: la mayor parte de un parque Windows son notebooks, y una tarea que esperara la
corriente dejaría a las máquinas móviles reportando solo cuando están en el dock.

Todo un piso que vuelve de una ventana de parches igual no reporta en el mismo segundo, pero quien lo
dispersa es **el agente, no la tarea**: cada host deriva un desfase pequeño y permanente de su propio
machine ID, y llega a su momento de reportar en un instante distinto al de sus vecinos. (El retardo
aleatorio de un minuto de la tarea viaja en su ciclo de cinco minutos, no en su disparador de
arranque, así que no es lo que desfasa a un piso que acaba de reiniciarse.)

Como en Linux, **el ciclo de 5 minutos no es la frecuencia de reporte.** Cada cuánto reporta
realmente un host se define de forma central en **Configuración → Instancia → Agentes de reporte**;
un ciclo que llega antes de tiempo termina de inmediato sin hacer nada. Cambiar la frecuencia nunca
toca la tarea.

### El binario todavía no está firmado

El ejecutable de Windows está actualmente **sin firmar**. SmartScreen va a advertir sobre él, y
algunos antivirus lo van a poner en cuarentena apenas lo vean: si la instalación falla en el paso de
"ejecutarlo una vez", eso es lo primero que hay que revisar.

Es un estado deliberado y temporal, para **validación interna dentro de la organización que
construye lazyit**, en su propio dominio y sus propias máquinas. **No despliegues este agente de
Windows en un cliente ni en un tercero hasta que esté firmado con un certificado de firma de código
OV o EV.** Firmarlo no cambia nada del comportamiento del agente: es el mismo programa en ambos
casos.

### ¿Reporta contenedores Docker, como en Linux?

Sí, cuando el host tiene un cliente Docker instalado y el motor está corriendo — Docker Desktop o el
runtime de contenedores en Windows Server. Los contenedores aparecen exactamente igual que desde un
host Linux: cada uno se convierte en un nodo propio vinculado a la máquina.

Y la respuesta a la pregunta que sigue también es sí: **si registrás una máquina Windows sin Docker e
instalás Docker un mes después, empieza a reportar sus contenedores en el ciclo siguiente.** El
agente busca el runtime en cada ejecución y no recuerda nada: no hay que reinstalar ni reiniciar
nada. Una máquina sin Docker simplemente no reporta lista de contenedores, en silencio, y eso no se
trata como un problema.

Una diferencia honesta: en Windows el agente le pregunta al comando `docker`, mientras que en Linux
lee directamente el socket local del runtime. Los datos que llegan a lazyit son los mismos, con una
excepción: el **digest** de la imagen no está disponible a través del comando, así que un contenedor
reportado desde Windows muestra la etiqueta de su imagen pero no el digest.

### Dónde vive cada cosa

| | Linux | Windows |
| --- | --- | --- |
| El programa | `/usr/local/bin/lazyit-agent` | `C:\Program Files\lazyit-agent\lazyit-agent.exe` |
| Configuración (contiene el token) | `/etc/lazyit-agent/config` | `C:\ProgramData\lazyit-agent\config` |
| Estado local | `/var/lib/lazyit-agent` | `C:\ProgramData\lazyit-agent\state` |
| Qué lo ejecuta | timer de systemd | Tarea programada `lazyit-agent` |

Todo lo demás — los límites locales que podés fijar, la configuración de proxy y de autoridad
certificadora, qué sobrevive a una reinstalación — funciona igual y vive en ese mismo archivo de
configuración, con los mismos nombres de clave.

### Hardware viejo o virtualizado

En Linux el instalador lee la lista de características del propio CPU y elige automáticamente una
compilación compatible. Windows no expone un equivalente, así que en una máquina anterior a 2013 — o
en un clúster Hyper-V/VMware configurado para presentar un CPU más viejo a sus huéspedes — pasá
**`-Baseline`** para instalar la compilación compatible. Si te equivocás, la verificación de
"ejecutarlo una vez" lo detecta antes de registrar nada.

## Desinstalar el agente

Volvé a ejecutar el script de instalación con `--uninstall`:

```sh
sudo sh install.sh --uninstall
```

En Windows, desde una PowerShell elevada:

```powershell
& ([scriptblock]::Create((irm https://tu-instancia/install.ps1))) -Uninstall
```

Detiene y elimina lo que ejecuta al agente — el timer y ambas unidades de systemd en Linux, la tarea
programada en Windows — y después el binario, el estado local del agente y su archivo de
configuración, incluido **el token**, que se destruye con cualquiera de las opciones. Es seguro
ejecutarlo dos veces, y seguro sobre una instalación a medias.

Si estás reimaginando una máquina que va a volver a tener el agente, agregá **`--keep-config`**
(Linux) o **`-KeepConfig`** (Windows):
conserva los límites propios de ese host y su configuración de proxy (lo que eligió el dueño de la
máquina, que es molesto de reconstruir) y de todos modos quita el token y la dirección de la
instancia. No hay ninguna opción que deje el token: una credencial que funciona contra tu instancia no
debería sobrevivir en una máquina que acabás de dar de baja.

Dos cosas que desinstalar **no** hace, deliberadamente. La entrada del servidor en lazyit queda tal
como está: descartala desde la vista de Servidores si querés sacarla del mapa. Y el token solo se
elimina *de ese host* — si ninguna otra máquina lo usa, revocá la cuenta de servicio en
[Cuentas de servicio](/help/users-permissions-service-accounts).

## Revisión pendiente

Los hosts descubiertos no entran directo a tu inventario: te esperan en la bandeja de **Revisión
pendiente** arriba de la vista de Servidores, cada uno mostrando su nombre de host, su tipo, de dónde
vino el reporte y hace cuánto reportó por última vez. Para cada uno tenés tres opciones:

- **Confirmar** — suma el host a tu topología activa. Un diálogo breve te permite renombrarlo y
  cambiar su tipo antes, y ofrece un interruptor **Registrar como activo de inventario** (**activado**
  por defecto): si lo dejás activado, lazyit también crea un **activo** registrado con los datos
  reportados del host, así el servidor puede tener responsable, artículos de la base de conocimiento y
  referencias a secretos como cualquier otro activo. Si el host reportó un **número de serie** de
  hardware real, ese pasa a ser el serie del activo automáticamente (un texto de relleno como
  *"To be filled by O.E.M."*, o un serie que ya usa otro activo, se descarta). Desactivá el
  interruptor para dejar el nodo solo en el grafo.
- **Unificar con…** — este host ya lo tenés. Elegí el servidor existente que realmente es y su clave
  de reporte se muda ahí: los próximos reportes llegan a ese servidor y esta propuesta se archiva.
  Usalo cuando una máquina fue **reinstalada** (un sistema operativo nuevo le da un machine ID nuevo,
  así que vuelve como si fuera desconocida mientras el servidor que ya habías curado queda en silencio),
  o cuando lazyit separó un host clonado (más abajo). El servidor que elijas conserva lo que
  configuraste: nombre, tipo, posición, responsable, activo vinculado y conexiones, y una IP que
  cargaste a mano sigue siendo tuya. Lo que se muda es la clave de reporte y los datos reportados que
  vienen con ella, así que una IP que había completado el *agente* pasa a ser la del host entrante.
  **Si el servidor que elegís ya reporta con un agente propio, esa clave de reporte se reemplaza**: es
  justo lo que querés después de una reinstalación, pero significa que un host que siga reportando con
  la clave anterior vuelve como un servidor pendiente nuevo. La fila archivada deja registro de las dos
  claves —la que entregó y la que se reemplazó— y ella misma ya no conserva ninguna, así que
  restaurarla devolvería la entrada y tus ediciones, nunca la clave de reporte.
  Si los dos reportan el mismo número de serie o la misma dirección de placa de
  red, el diálogo te lo dice arriba (*"esto parece srv-app-04"*); eso solo aparece si ambos fueron
  reportados por un agente lo bastante reciente como para enviar esos datos, y es una sugerencia que
  confirmás vos, nunca una decisión tomada por el sistema.
- **Descartar** — elimina la propuesta. Es un borrado lógico (igual que quitar cualquier nodo del
  mapa): no se destruye nada y se puede restaurar más adelante. **Descartar no detiene al agente.**
  Si ese host todavía tiene el agente instalado y corriendo, su próximo reporte lo vuelve a informar
  y reaparece como una propuesta nueva. Para que deje de aparecer, desinstalá el agente en ese host
  (`sudo sh install.sh --uninstall`, ver **Desinstalar el agente** más arriba) — o revocá el token
  que usa.

Un host descubierto también **completa su propia dirección IP** apenas reporta: no hace falta que la
escribas. En cada reporte posterior la IP se actualiza al valor actual, **salvo que la hayas editado a
mano** en el nodo: una IP manual se considera tuya y el agente nunca la sobrescribe.

**Ahora cada propuesta llega ya clasificada.** Una máquina recién descubierta se propone como
**máquina virtual**, **contenedor** o **host físico**, según lo que ella misma reporta, en vez de que
todos los servidores aterricen como host físico para que los corrijas uno por uno. Cuando el agente
realmente no puede determinarlo — la herramienta que necesita no está instalada — propone *host
físico*, igual que antes, en vez de adivinar. Es solo una propuesta: el selector **Tipo** del diálogo
de confirmación está ahí mismo, y una vez que confirmaste un nodo **ningún reporte posterior vuelve a
cambiarle el tipo**, aunque la máquina empiece a reportar otra cosa.

### Revisar muchos a la vez

Un solo host Docker puede agregar una docena de propuestas en un mismo reporte — él mismo más un nodo
por cada contenedor en ejecución — así que la bandeja está pensada para resolverse de una pasada y no
de a un cuadro de diálogo por vez.

- **Los contenedores quedan debajo del servidor que los reportó.** Cada grupo se encabeza con el
  nombre del servidor y la cantidad de contenedores, y la casilla de ese encabezado toma el servidor
  **y** sus contenedores juntos. Así se confirma un host con todo lo que corre arriba en una sola
  acción. Si el servidor ya lo confirmaste, sus contenedores nuevos igual aparecen bajo su nombre.
- **Casillas y los dos botones de selección.** Marcá lo que quieras y usá **Confirmar selección** o
  **Descartar selección**. Confirmar en conjunto hace exactamente lo mismo que confirmar de a uno:
  seguís aprobando cada elemento, solo que sin un cuadro de diálogo por fila. **Seleccionar todo lo
  visible** abarca lo que se está mostrando, nunca las filas que un filtro está ocultando.
- **La opción de activo está separada.** En el cuadro de selección, los servidores se registran como
  activos de inventario por defecto (igual que de a uno) y **los contenedores no se registran por
  defecto**. Un contenedor lo reemplaza el próximo despliegue, no tiene número de serie que registrar
  y un host movido puede sumar decenas, así que quedan en el mapa sin llenar tu lista de activos con
  filas que nadie va a mantener. Los dos interruptores están ahí por si tu caso es distinto.
- **Reclasificá toda la selección** con el selector de tipo si el agente se equivocó con todos.
  Renombrar sigue estando en el cuadro de Confirmar individual, que es donde tiene sentido.
- **Un resultado parcial se informa como tal.** Si algunos elementos no se pudieron aplicar — un
  número de serie que choca con un activo existente, una propuesta que otra persona descartó un
  momento antes — el resto igual se aplica y se te dice cuántos fueron y cuál falló primero.
- **Filtrá** por nombre (`srv-*` funciona como patrón) o IP, por subred (`10.20.0.0/16`), por tipo
  reportado y por servidores frente a contenedores; y **ordená** por cuándo apareció por primera vez o
  por nombre. Los filtros acotan lo que estás viendo; una acción en conjunto nunca alcanza algo que no
  podés ver. **Un filtro que oculta una fila marcada la saca de la acción y de la cuenta**, así que el
  número que ves junto a los botones siempre son filas en pantalla. Si volvés a ampliar el filtro, esa
  fila reaparece marcada y contada, algo que ves suceder, a diferencia de una confirmación que no
  sabías que estabas haciendo.
- **Una acción toma como máximo 200 elementos.** Por encima de eso los dos botones quedan
  deshabilitados y te dicen el número, antes de que presiones nada. Acotá con un filtro y hacelo en
  más de una pasada.

### Reglas de confirmación automática

Si notás que tomás la misma decisión una y otra vez — *"todo lo que se llame `srv-*` en la VLAN de
gestión es una máquina virtual y lo quiero registrado"* — podés escribirlo una sola vez. Abrí
**Reglas de confirmación automática…** en la parte superior de la bandeja.

Una regla tiene un **nombre**, a qué **se aplica** (servidores, contenedores o ambos) y al menos una
condición: un **patrón de nombre** (`*` para cualquier secuencia de caracteres, `?` para exactamente
uno; tiene que coincidir el nombre completo), una **subred** en formato CIDR, o el **tipo que el
reporte del agente hizo que lazyit propusiera**. Después indica qué hacer: con qué tipo confirmarlo y
si registrarlo como activo de inventario.

**Tené claro qué estás activando.** Un host que coincide con una regla se confirma en el momento en
que reporta: esa fila nunca pasa por la bandeja, y si la regla indica registrarlo, también se crea su
activo. La decisión sigue siendo tuya, pero la estás tomando *una vez y por adelantado*, para hosts
que todavía no conocés. Eso es lo que la hace útil y también lo que cuesta: cuanto más acotada sea la
regla, menor la sorpresa. Si alguien llegara a obtener el token de tu agente, un host inventado que
encaje en alguna de tus reglas entra confirmado en lugar de quedar esperando en la bandeja.

Lo demás que conviene saber antes de escribir una:

- **Una regla se aplica solo a partir del próximo reporte.** Nada de lo que ya está esperando en tu
  bandeja se confirma por su cuenta: eso lo seguís revisando vos, de a uno o en conjunto. Guardar una
  regla nunca toca una propuesta que ya podés ver.
- **Una regla necesita una condición que pueda descartar algo.** Un patrón de nombre tiene que llevar
  al menos un carácter literal, y una subred tiene que ser más acotada que `/0`. La mayoría de los
  patrones hechos solo de comodines (`*`, `**`, `*?*`) coinciden con todos los hosts que existan, igual
  que `0.0.0.0/0` son todas las direcciones que existen: lazyit no guarda ninguna de las dos, ni por
  separado ni juntas, porque una regla que no descarta nada es simplemente "confirmá todo lo que
  encuentre el agente", que es justamente lo que la bandeja de pendientes existe para evitar. Algunos
  patrones hechos solo de comodines sí acotan: `?` por sí solo coincide únicamente con nombres de un
  carácter. lazyit también los rechaza, a propósito, porque "el patrón lleva un carácter literal" es
  una línea que podés verificar a simple vista, y ningún parque de servidores se describe con "nombres
  de exactamente un carácter": el costo de rechazarlos es solo que esas propuestas esperan en la
  bandeja, que es adonde iban de todos modos. `srv-*` es una condición; `*` no lo
  es. Igual podés usar `*` junto a una condición real: *cualquier cosa, en `10.20.0.0/16`* es una
  regla; *cualquier cosa, en cualquier lado* no.
- **Lo que descartaste queda descartado.** Si descartás una propuesta y esa misma máquina vuelve a
  reportar, reaparece como un pendiente nuevo para que la mires: ninguna regla la confirma por su
  cuenta. Tu "no" está por encima de tus reglas.
- **La opción de activo arranca desactivada en toda regla que pueda alcanzar contenedores.** Una regla
  solo de servidores los registra como activos por defecto; una regla de contenedores *o* una de
  "servidores y contenedores" no los registra por defecto, con el mismo criterio que el cuadro de
  selección. Activalo si esos contenedores realmente son algo que registrás.
- **Sigue siendo tu decisión, y queda registrada como tuya.** La regla muestra quién la escribió, y
  cada activo que crea queda atribuido a vos, igual que si hubieras hecho clic en Confirmar. Las
  reglas se listan en el orden en que se evalúan (el número de la izquierda) y gana la **primera** que
  coincide.
- **Podés dar marcha atrás cuando quieras.** El interruptor desactiva una regla al instante: desde el
  próximo reporte nada vuelve a coincidir con ella, y borrarla la elimina. Los servidores que ya
  confirmó quedan confirmados: ya son parte de tu inventario, y desconfirmarlos sería tan al revés
  como aplicar una regla al pasado.
- **Podés ver si está haciendo algo.** Cada regla muestra cuántas veces se usó y cuándo fue la última.
- **Una regla de subred nunca coincide con un host que no reportó dirección**, y un **ID de máquina
  clonado** nunca se confirma automáticamente: esas dos filas existen precisamente para que las veas
  (más abajo).

### Los contenedores aparecen como nodos propios

Si el host corre **Docker** (o un runtime compatible) y el agente puede leer su socket, cada
contenedor **en ejecución** se propone como su propio nodo de tipo **contenedor**, conectado al
servidor donde corre por un vínculo **corre en**. Ese vínculo es el punto: es lo que hace que el
**radio de impacto** de un servidor — "¿qué se rompe si se cae este equipo?" — incluya los
contenedores que tiene arriba, sin que dibujes una sola conexión a mano.

Algunas cosas que conviene saber:

- **Los contenedores también son propuestas.** Llegan a la misma bandeja de Revisión pendiente, y los
  confirmás o descartás igual que a un servidor. Un host cargado puede sumar varias propuestas de una
  vez, y para eso están la agrupación y las acciones en conjunto de más arriba: la bandeja pone los
  contenedores de un host bajo su nombre, y la casilla de ese grupo los toma juntos.
- **Un contenedor recreado es el mismo nodo.** Redesplegar (`docker compose up`, un cambio de imagen)
  no crea un duplicado: los contenedores se identifican por **nombre** dentro de ese host, así que tu
  nodo confirmado, su posición y sus vínculos sobreviven al redespliegue.
- **Un contenedor que se detiene** desaparece del reporte y su nodo queda **fuera de línea**. Nunca se
  elimina a tus espaldas: eliminarlo es decisión tuya, con la misma acción Descartar. Si vuelve con el
  mismo nombre, su nodo simplemente vuelve a estar en línea.
- **Solo se reportan los contenedores en ejecución.** Una tarea puntual ya terminada no es inventario
  que valga la pena mapear.
- **En hosts sin Docker no pasa nada**, y un agente que no puede leer el socket de contenedores
  simplemente no reporta ninguno: nunca elimina los nodos de contenedor que ya tenés.
- La **imagen, el digest, el id de runtime y los puertos publicados** del contenedor se muestran en el
  propio nodo, en un panel de solo lectura **Contenedor** — abrí el contenedor en el diagrama o en la
  lista de Servidores. Si lo confirmaste con el seguimiento como activo encendido, ese mismo panel
  aparece también en su página de activo.

Una vez confirmado, un host sigue recibiendo datos frescos del agente, pero tus ediciones — su
nombre, tipo, posición, IP y conexiones — son tuyas y el agente nunca las sobrescribe. El inventario
reportado — sistema operativo, CPU, memoria, discos, interfaces de red, número de serie y software
instalado — se muestra como un panel de solo lectura **Datos reportados** en el propio nodo (abrí un
nodo en el diagrama o en la lista de Servidores), y los mismos datos aparecen en el activo
correspondiente. Ambos se mantienen frescos: cada reporte los actualiza sin tocar nada que sea tuyo
(el nombre, el número de serie y el modelo del activo nunca cambian por un reporte). Esto ahora
incluye los **contenedores**: un contenedor que confirmaste como activo mantiene su imagen, su digest,
su estado y sus puertos publicados al día en la página del activo, donde antes quedaban tal como
estaban el día en que lo confirmaste.

> [!tip] "Recolectado hace 3 días" no significa que el servidor haya dejado de reportar
> El panel de inventario indica cuándo se **recolectaron esos datos**, y lazyit sólo reescribe el
> inventario almacenado cuando algo cambió de verdad: un servidor cuyo software y hardware llevan dos
> semanas estables conserva una marca de recolección de hace dos semanas mientras reporta perfectamente
> cada pocos minutos. Para saber *si el host sigue reportando*, mirá su hora de **último reporte** en la
> lista de Servidores o en el panel del nodo; esa avanza en cada reporte.

## Cuando dos servidores dicen ser la misma máquina

lazyit distingue tus máquinas por la identidad que el sistema operativo escribe al instalarse:
`/etc/machine-id` en Linux, `MachineGuid` en Windows. Funciona bien, hasta que se arma una **plantilla
de VM o una imagen dorada que ya la trae adentro**. Todas las máquinas clonadas de ahí reclaman la
misma identidad y, sin un control, se apilarían en una sola fila: un servidor en tu mapa, doce en tus
racks. Es la forma más común de terminar con un inventario que se equivoca con total seguridad, y es
la razón por la que existen tanto `systemd-firstboot` como `sysprep`.

lazyit lo controla. Cuando un reporte reclama un ID que ya usa otro servidor, compara el hardware que
reportan los dos: si el **número de serie y las direcciones de placa de red son ambos distintos**, son
dos máquinas, no una. Ambos, para que un cambio legítimo en un servidor real nunca se confunda con un
clon: cambiar una placa de red mueve solo las direcciones, cambiar la placa madre mueve solo el serie.

El **nombre de host queda deliberadamente fuera del control**: una máquina clonada de una plantilla
suele traer también el nombre de la plantilla, así que exigir que los nombres difieran habría dejado
pasar justamente los clones que esto existe para detectar. Cuando los dos servidores sí responden al
mismo nombre, la notificación lo dice: es la señal más clara de que estás mirando una imagen dorada.

Cuando se detectan dos máquinas:

- El host nuevo obtiene **su propia entrada** en Revisión pendiente en lugar de pisar la primera. Sus
  datos reportados, su IP y su nombre de host quedan suyos.
- **No se unifica ni se cambia nada** en el servidor que ya estaba: el control solo puede frenar una
  unificación, nunca reescribir algo que ya tenías.
- Recibís **una sola notificación** en la campana (no una por cada reporte). El título nombra a los dos
  hosts; el resumen arranca con el comando que lo soluciona (la campana recorta los resúmenes largos a
  una línea: pasá el mouse por encima para leerlo completo). La fila enlaza al mapa de topología.

La solución está en las máquinas, no en lazyit, y **el comando cambia según la plataforma**: por eso
la notificación nombra el que corresponde al host que reportó.

- **Linux.** En cada clon, borrá `/etc/machine-id`, ejecutá `systemd-firstboot --setup-machine-id` y
  reiniciá.
- **Windows.** En cada clon, ejecutá `sysprep /generalize`: eso es lo que genera un `MachineGuid`
  nuevo. Una imagen de Windows capturada *sin* generalizarla es exactamente la forma en que un parque
  Windows termina acá.

Corregí también la plantilla, o cada clon futuro repite el problema. Una vez que el clon tiene un ID
propio, simplemente reporta como un host nuevo: confirmalo, o usá **Unificar con…** para plegarlo
sobre la entrada que lazyit le creó mientras tanto.

Todo esto necesita los datos de hardware que envía un agente **actual**, y necesita que ese agente
efectivamente los tenga. Dos cosas dejan a un host fuera del control, y ambas son silenciosas:

- **Un agente viejo.** Los hosts que todavía corren un agente anterior a estos datos nunca se comparan
  — ni generan avisos — hasta que reporten con uno actualizado; nada de lo que ya tenés se toca al
  actualizar.
- **No hay número de serie para comparar.** El control necesita un número de serie *y* direcciones de
  placa de red. En Linux el número de serie lo da `dmidecode`, que solo responde si el agente corre
  **como root** y la herramienta está instalada — y un **guest LXC o de contenedor no tiene número de
  serie de hardware, punto**, corra como root o no. En Windows lo da `Win32_BIOS` y requiere
  **Administrador**, que la tarea programada ya tiene; ejecutado a mano desde una consola común, vuelve
  vacío. Un host sin número de serie se saltea igual que uno viejo: lazyit lee un dato ausente como
  "nada para comparar", nunca como una diferencia, así que no avisa sobre una suposición.

Es decir que una flota con el agente más nuevo puede igual quedarse **sin ninguna detección de
clones**. La señal está en el panel de **Datos reportados**: si un host no muestra número de serie, ese
host no se está controlando. Para saber *por qué*, ejecutá `lazyit-agent show` en el host: sus notas de
recolección ahora nombran la fuente que volvió vacía y el error detrás, tanto en Windows como en Linux
(ver *Qué recopila el agente*, más abajo; todavía nada muestra esas notas en la interfaz). Si la
detección de clones te importa, corré el agente como root (en Linux, con `dmidecode` instalado) o
desde la tarea programada (en Windows), y no esperes nada de él en guests de contenedor.

## Qué recopila el agente

- **Identidad y hardware** — nombre de host, sistema operativo y kernel, CPU y memoria, discos e
  interfaces de red y (solo cuando se ejecuta como root) fabricante / modelo / número de serie. Ahora
  también lee direcciones **IPv6**: la lista de interfaces sigue mostrando la IPv4 de cada una, pero un
  host que no tiene ninguna IPv4 por fin obtiene una dirección en el diagrama de infraestructura en vez
  de un vacío.
- **Qué tipo de máquina es** — servidor, escritorio, notebook, máquina virtual o contenedor, y la
  virtualización sobre la que corre (KVM, VMware, Hyper-V, Xen, LXC, Docker, WSL…) cuando puede
  determinarlo. Cuando *no* puede — la herramienta que necesita no está instalada — reporta
  **desconocido** en vez de adivinar, y lo aclara en las notas de abajo. Esto es lo que lazyit usa
  para proponer el **tipo** de una máquina recién descubierta (ver Revisión pendiente, más arriba);
  los valores en bruto se guardan junto a los demás datos reportados del host y ninguna pantalla los
  muestra directamente.
- **Los contenedores que corre** — nombre, imagen, digest de la imagen, estado y puertos publicados,
  por cada contenedor **en ejecución**, cuando el host corre Docker (o un runtime compatible) y el
  agente puede leer su socket. Cada uno se convierte en un nodo propio vinculado al host, con esos
  datos en un panel **Contenedor** sobre el nodo (ver Revisión pendiente, más arriba). Sigue siendo la
  máquina local describiéndose a sí misma: el agente le pregunta al runtime de ese host qué está
  corriendo *él* — nunca escanea tu red.
- **Cuándo arrancó por última vez** — una sola marca de tiempo, actualizada en cada reporte y sin
  histórico: es un dato de inventario ("¿este equipo realmente se reinició después de la ventana de
  parches?"), no monitoreo de uptime. Se guarda junto a los demás datos reportados del host y, igual
  que el tipo de máquina, todavía no se muestra en ninguna pantalla.
- **Software instalado** — la lista de paquetes instalados, con versiones cuando están disponibles. En
  Windows es lo que está instalado **para toda la máquina**, leído tanto de la mitad de 64 bits como
  de la de 32 bits del registro (perder la segunda es la forma clásica en que un script de inventario
  casero pierde la mitad en silencio); las entradas que Windows marca como ocultas — fragmentos de
  runtime y restos de actualizaciones — quedan afuera, así que la lista es la que una persona
  reconocería. **El software que un usuario instaló sólo para sí mismo no aparece**: eso se registra
  en la parte del registro de ese usuario y no en la de la máquina, así que la lista se parece a la
  que Windows muestra en *Aplicaciones y características* pero no es la misma, y será más corta en una
  notebook cuyo dueño instala cosas para su propia cuenta. El
  agente además registra qué gestor de paquetes o fuente reportó cada uno; la lista en sí muestra el nombre y
  la versión. En un servidor con muchos paquetes esta lista es, de lejos, lo más pesado que viaja en un
  reporte y sólo cambia cuando alguien instala o actualiza algo, así que el agente la envía **una vez y
  después envía sólo una huella de ella** hasta que cambie, lo que reduce un reporte de rutina a
  aproximadamente una décima parte de su tamaño. El panel sigue mostrando la lista completa: la
  abreviatura es sólo la forma en que viaja. Conviene conocer un caso: cuando el agente no logra
  enumerar los paquetes (no hay un gestor de paquetes compatible, o la recolección expiró), lazyit
  **conserva la lista que ya tiene** en lugar de vaciar el panel, y el panel no lo señala por sí mismo
  — la fecha de **Recolectado** es la que indica qué tan antigua es la lista. Un agente sólo empieza a
  omitir la lista una vez que lazyit le avisó — en la respuesta a un reporte anterior — que esta versión
  entiende esa abreviatura, así que un agente actualizado antes que su instancia sigue enviando la lista
  completa. El ahorro llega cuando ambas mitades están al día. El único momento a tener en cuenta es el
  movimiento inverso: **bajar** una instancia a una versión anterior a ésta mientras sus agentes ya son
  nuevos cuesta un reporte, cuya lista esa versión anterior lee como «sin software»; el agente ve la
  respuesta antigua y vuelve a enviar la lista completa en el reporte siguiente. Si lazyit tiene una lista que ya no logra hacer
  coincidir con la huella (después de restaurar un respaldo, por ejemplo), **conserva la lista que ya
  tiene** y le pide al agente una completa en el siguiente reporte, en lugar de vaciar el panel ante
  una duda. Un servidor que **descartaste** y que luego volvió a descubrirse es un caso distinto, y
  conviene saberlo: vuelve como un registro nuevo, sin ninguna lista de paquetes, así que su panel de
  Software está realmente vacío hasta que la lista completa llegue con el siguiente reporte — como
  máximo un intervalo de reporte (15 minutos por defecto). Desactivar la recolección de software en la
  configuración del agente es otra cosa distinta, y deliberada: la lista guardada se borra, para que
  nunca quedes leyendo versiones de paquetes que ya nadie está recolectando.
- **Qué no pudo recopilar** — cada reporte también indica si corrió como root (Administrador en
  Windows) y nombra lo que tuvo que omitir o lo que agotó su tiempo. En Windows todo el barrido es una
  sola llamada de PowerShell que sigue adelante ante una falla en lugar de abortar el reporte, así que
  también nombra **cada dato que volvió vacío** — el número de serie, los discos, las placas de red, la
  identidad de la máquina — y deja pasar el texto del error del propio Windows, que es la diferencia
  entre una columna vacía y una columna vacía sobre la que podés actuar. Si ejecutás
  `lazyit-agent show` imprime esas notas ahí mismo, sin
  enviar nada, que suele ser la forma más rápida de responder "¿por qué está vacía la columna
  de número de serie de este host?". (`lazyit-agent report --once --force` también las imprime, y
  envía el reporte.) lazyit además las guarda junto a los datos reportados del host,
  para que una futura vista de parque pueda responderlo para todo el estado; hoy no se muestran en la
  interfaz.

Recopila todo lo que puede y simplemente omite lo que no puede leer, así una instalación sin
privilegios igual reporta una imagen útil. **Nunca** lee secretos, archivos ni datos de aplicaciones,
y no envía métricas.

En Windows, todos esos datos provienen de una **única** consulta a las interfaces de inventario del
propio sistema operativo, hecha una vez por reporte. Dos cosas que nunca toca, deliberadamente: la
clase de WMI que enumera los paquetes MSI instalados — hacer esa pregunta hace que Windows
*reconfigure* cada paquete instalado, lo que satura el registro de eventos y tarda minutos — y el
comando `wmic`, ya obsoleto, que Microsoft eliminó en Windows 11 24H2 y Server 2025.

## Configurá todos los agentes desde una sola pantalla

No se editan los agentes host por host. **Configuración → Instancia → Agentes de inventario** define
la política de todos los agentes del parque, y cada uno la toma en su próximo reporte.

Lo que podés configurar ahí:

- **Con qué frecuencia informa cada host** — de 5 minutos a 24 horas. Esta es la opción que antes
  implicaba editar un temporizador de systemd en cada máquina.
- **Cuánto espera lazyit antes de marcar un host fuera de línea.** Tiene que ser mayor que el
  intervalo de informe, o un host perfectamente sano queda marcado fuera de línea entre dos de sus
  propios reportes — el editor no te deja guardar un valor que provoque eso.
- **Qué recolectores se ejecutan** — hardware, discos, interfaces de red, software instalado,
  contenedores. Un recolector desactivado directamente no se ejecuta: el agente no reúne los datos
  para después descartarlos.
- **Qué dejar afuera** — patrones de nombre para interfaces de red (`veth*`, `docker*`), puntos de
  montaje (`/var/lib/docker/*`, `/snap/*`) y paquetes (`linux-image-*`), más un tope estricto de
  cuántos paquetes puede informar un host. `*` coincide con cualquier texto y `?` con un solo
  carácter; no se aceptan expresiones regulares.

Hay tres cosas que conviene saber antes de usarlo.

**Un cambio llega en el próximo reporte, no al instante.** La política viaja de vuelta en el reporte
de cada host, y el host la aplica en la ejecución *siguiente* — así que dejá pasar hasta dos
intervalos. Esa demora es intencional: un agente solo aplica una política que ya tenía cuando
arrancó, de modo que un error acá nunca puede interrumpir al parque a mitad de una recolección.

**Cada host puede negarse, y lazyit no puede pasar por encima.** El propio
`/etc/lazyit-agent/config` de un host puede desactivar un recolector
(`LAZYIT_COLLECT_SOFTWARE=false`), fijar un piso de frecuencia (`LAZYIT_MIN_INTERVAL=3600`), limitar
su lista de paquetes (`LAZYIT_SOFTWARE_MAX=500`) o agregar sus propias exclusiones
(`LAZYIT_EXCLUDE_NICS=veth*`). Esa configuración **prevalece**, siempre, y nada de lo que definas en
lazyit puede volver a activar un recolector desactivado localmente. Es a propósito: lazyit es
autoalojado, y quien administra un servidor no siempre es quien administra lazyit. La configuración
local solo puede hacer que un host informe *menos*, nunca más. **Volver a ejecutar el comando de
instalación la conserva.** Actualizar un agente reescribe ese archivo, así que el instalador traslada
todas las líneas `LAZYIT_*` que encuentra —salvo las tres que le pertenecen (`LAZYIT_URL`,
`LAZYIT_TOKEN` y la obsoleta `LAZYIT_INTERVAL`, que ya nadie lee)— y delimita lo que conservó bajo una
marca `--- kept from this host's previous config ---` para que veas exactamente qué sobrevivió. Una
actualización nunca vuelve a activar un recolector en silencio.

**lazyit nunca puede indicarle a un agente que ejecute algo.** La política es una lista fija de
interruptores, números y patrones de nombre — no hay ningún campo para un comando, un script, una
ruta de archivo ni una expresión regular, y no está previsto agregarlo. Eso es lo que mantiene el peor
caso de un token de agente robado en "propuestas que descartás" y no en "código ajeno ejecutándose
como root en todos tus servidores".

**¿Se aplicó?** Cada host informa qué versión de la política está ejecutando, así podés distinguir
"configurado" de "efectivamente aplicado". Abrí un servidor en el [diagrama de
infraestructura](/help/assets-topology-diagram) y su panel muestra **Política v7 · aplicada** o
**Política v8 · pendiente** — pendiente significa simplemente que ese host no reportó desde tu cambio.
Un servidor descubierto por un agente anterior a esta versión no muestra ninguna de las dos, porque
nunca informa una versión de política.

## Seguridad

- **Un permiso acotado.** El token tiene **solo** `infra:report`. No puede leer ni modificar nada más
  en lazyit — ni activos, ni secretos, ni otra infraestructura. Lo peor que puede hacer un token
  filtrado es crear propuestas que vos descartás.
- **Una compuerta humana.** Todo lo que el agente reporta queda como **Pendiente** y solo pasa a ser
  parte de tu inventario cuando lo confirmás. Un escritor automático nunca puede cambiar tus registros
  oficiales en silencio.
- **Nunca secretos.** El agente no lleva claves ni lee ninguna bóveda — los valores de tus secretos
  quedan intactos.
- **Ninguna credencial guardada en Windows.** La tarea programada corre como `NT AUTHORITY\SYSTEM`,
  que tiene los permisos locales necesarios sin que se escriba ninguna contraseña en ningún lado. Una
  cuenta de servicio de dominio habría significado una credencial funcional en un archivo en cada
  máquina del parque, así que no se ofrece.
- **El binario de Windows todavía no está firmado.** Se dice claramente porque importa: sirve para
  validación interna en tu propio dominio, y **no** está listo para entregarse a un tercero. Ver
  [Hosts Windows](#hosts-windows), más arriba.
- **Un servicio confinado.** En Linux el agente corre como root, porque leer el número de serie y el
  modelo de una máquina lo requiere — pero la unidad de systemd bajo la que corre está restringida bastante por
  debajo de lo que root normalmente puede hacer: no puede obtener privilegios nuevos, no ve los
  directorios personales de los usuarios, tiene un `/tmp` privado, y no puede modificar parámetros del
  kernel, grupos de control, ni siquiera su propio programa y su configuración. Abrí
  `/etc/systemd/system/lazyit-agent.service` y leelo; es corto, y está escrito para ser leído. Además
  corre con la **prioridad de CPU y disco más baja del sistema**, así que listar tres mil paquetes en
  un servidor de base de datos ocupado nunca compite con aquello para lo que ese servidor existe.
- **La descarga se verifica.** Tu instancia publica una huella del binario del agente junto al binario
  mismo, y el instalador se niega a instalar uno que no coincida. Es una verificación de integridad,
  no una firma criptográfica: detecta una descarga corrupta o desactualizada, y una manipulación donde
  se cambió solo uno de los dos archivos. Pasá `--require-checksum` (o `-RequireChecksum` en Windows)
  para que una huella *ausente* también sea fatal.
- **Puede usar tu autoridad certificadora, no la de la máquina.** `--ca-file` (o `LAZYIT_CA_FILE` en
  la configuración) apunta el agente a un paquete de certificados en el que confía solo él, así que
  una autoridad certificadora interna nunca tiene que instalarse a nivel de toda la máquina solo para
  que un agente de inventario pueda reportar.
- **Autoalojado y compatible con redes aisladas.** El comando de instalación apunta a *tu* instancia,
  el agente solo se comunica con esa instancia y funciona totalmente sin conexión. Los tokens se pueden
  revocar en cualquier momento desde [Cuentas de servicio](/help/users-permissions-service-accounts).
- **Límites de reporte.** Cada token está limitado de dos formas: **cada cuánto** puede reportar (por
  defecto 120 veces por minuto) y **cuántos nodos recién descubiertos** puede agregar (por defecto 100
  por hora — un contenedor descubierto cuenta igual que un servidor descubierto, porque ambos son
  filas de tu inventario). Juntos protegen tu base de datos de un agente descontrolado o robado — un
  token ya no puede llenarla de propuestas. Ambos valores por defecto asumen un parque de unos **100
  servidores** compartiendo un mismo token de instalación, así que un despliegue normal nunca los
  alcanza: los 100 servidores pueden descubrirse dentro de la primera hora. Dos cosas conviene saber.
  Un nodo que **ya confirmaste sigue reportando pase lo que pase** — sea servidor o contenedor.
  Alcanzar un límite solo demora los descubrimientos *nuevos*, nunca la disponibilidad ni el
  inventario de lo que ya tenés: un contenedor que sigue corriendo nunca se marca fuera de línea
  solo porque el límite impidió agregar *otro* distinto. No puede hacer que tu mapa muestre una caída
  falsa. Y **no hay que limpiar nada**
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

**Algunas mejoras solo llegan cuando volvés a ejecutar el comando de instalación.** El agente son dos
cosas: un programa, y el servicio y el timer de systemd que lo ejecutan. Todo lo que está en el
*programa* — los diagnósticos de más arriba, el soporte de proxy y de autoridad certificadora — llega
con un binario nuevo. Todo lo que está en el *servicio y el timer* — el confinamiento y la prioridad
baja descritos en Seguridad, y el horario distribuido que evita que todo el parque reporte en el mismo
segundo después de una ventana de mantenimiento — se escribe cuando corre el instalador, y un host
existente conserva la unidad que le tocó originalmente hasta que lo vuelvas a ejecutar. Volver a
ejecutarlo es seguro y conserva la configuración propia de ese host, así que en una flota que ya
tenés, vale la pena hacerlo una vez.

**Actualizar tu instancia nunca rompe los agentes ya instalados.** No hace falta reinstalar nada: un
agente más viejo sigue reportando igual que antes, y cada dato que envía aterriza exactamente donde
aterrizaba. En particular, **nada de lo que ya tenés se reclasifica**: la propuesta de tipo de máquina
descrita más arriba se aplica solo a los servidores descubiertos *de ahora en adelante*, así que cada
nodo de tu inventario conserva el tipo que tiene, y un agente viejo que no reporta contenedores nunca
elimina nodos de contenedor.

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

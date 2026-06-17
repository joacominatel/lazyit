---
title: Seguridad operativa
category: security-best-practices
subcategory: operational-security
order: 3
---

# Seguridad operativa

Operar lazyit de forma segura es, sobre todo, cuestión de unos pocos hábitos: respaldar lo correcto,
mantener el material de recuperación fuera del sistema y saber qué hacer cuando algo queda expuesto.
Esta página es la lista de verificación del operador.

## Respalda todo lo necesario para recuperar — no solo la base de datos

El error de recuperación ante desastres más común es respaldar solo la base de datos de la
aplicación. Una restauración que funcione necesita **más que eso**:

- **La base de datos de la aplicación** — tus activos, usuarios, accesos, Base de Conocimiento y los
  datos *cifrados* del Gestor de Secretos.
- **Los datos de tu proveedor de identidad** — si ejecutas el servicio de inicio de sesión incluido,
  sus cuentas y claves viven por separado. Restaura la base de datos de la aplicación sin ellos y
  todos quedan bloqueados.
- **Tu archivo de entorno / secretos** — los secretos del despliegue (contraseña de la base de datos,
  claves de cifrado del servicio de inicio de sesión y de las credenciales de conectores de
  workflow, el secreto de la app). Algunas de estas claves **no se pueden regenerar**: restaura una
  base de datos sin la clave correspondiente y esos datos quedan ilegibles.

Trata el archivo de secretos como **irremplazable**: guarda una copia cifrada **fuera del host**, y
nunca dejes que el servidor en ejecución sea su única copia. Prueba una restauración antes de confiar
en lazyit para algo real — un respaldo sin probar es una suposición.

> La sección de despliegue y operaciones de este Manual cubre la mecánica de respaldar y restaurar.
> Aquí lo importante es el **alcance**: base de datos **más** datos del proveedor de identidad **más**
> el archivo de secretos, guardados juntos y fuera del host.

## La recuperación del Gestor de Secretos es responsabilidad del operador — y es distinta

El Gestor de Secretos está **cifrado de extremo a extremo**: el servidor nunca puede leer tus secretos
compartidos (consulta [Gestor de Secretos](/help/secret-manager)). Eso tiene una consecuencia
contundente para la recuperación ante desastres que todo operador debe entender:

- **Una restauración perfecta de la base de datos y los secretos *no* vuelve a hacer legibles las
  bóvedas.** La restauración trae de vuelta únicamente datos cifrados. No hay una clave del lado del
  servidor sobre los valores de los secretos con la que recuperar — por diseño.
- **El material de recuperación lo tienen los usuarios, no tú.** La **clave de recuperación** de cada
  persona es su respaldo personal, que se muestra **una sola vez** cuando configura por primera vez
  el Gestor de Secretos y no se almacena en ningún lugar que el servidor pueda leer. No puedes
  respaldarla por ellos.
- **Una bóveda de un solo miembro que pierde su contraseña y su clave de recuperación se pierde para
  siempre** — ni una restauración, ni un administrador, ni el soporte pueden recuperarla.

Qué significa esto en la operación:

- **Haz que "guarda tu clave de recuperación fuera del sistema" forme parte de la incorporación.** Es
  un deber personal, no un elemento de respaldo del operador. Un gestor de contraseñas o una copia
  impresa en un lugar seguro están bien.
- **Mantén las bóvedas importantes con varios miembros.** Un segundo miembro puede restaurar el
  acceso de un compañero tras un restablecimiento. lazyit avisa cuando una bóveda tiene un solo
  miembro — haz caso a ese aviso.

## Respuesta a incidentes: qué hacer cuando un acceso queda expuesto

Cuando una credencial o una cuenta pudo quedar expuesta, trabaja en este orden.

### Una persona se va, o una cuenta queda comprometida

1. **Da de baja o deshabilita la cuenta** para que ya no pueda iniciar sesión. En lazyit, dar de baja
   a un usuario le quita el acceso; si ejecutas tu propio proveedor, deshabilítalo también allí.
2. **Revoca su acceso a aplicaciones y su membresía en bóvedas.** Quitar a una persona de una bóveda
   detiene su acceso a los secretos a través de lazyit de ahí en adelante.

### Un secreto compartido pudo filtrarse

Revocar un acceso en lazyit detiene el acceso *futuro* — **no** "des-cuenta" un secreto que alguien ya
vio, ni vuelve a cifrar retroactivamente lo que ya podía leer. Así que, para una credencial que pudo
quedar realmente expuesta:

> **Rota la credencial subyacente.** Cambia la contraseña, clave o token reales en el origen, y luego
> actualízalos en lazyit. Esa es la única solución real — y es así en cualquier gestor de
> contraseñas, no solo en lazyit.

### Un secreto o una clave del despliegue pudo filtrarse

Si un secreto del despliegue (una contraseña de base de datos, una clave de cifrado, un secreto de
cliente OIDC) pudo quedar expuesto, rota lo que *se pueda* rotar y vuelve a desplegar. Ten en cuenta
que un par de claves de cifrado son **no rotables por diseño** — perderlas o filtrarlas es grave, y
por eso mismo deben estar en un respaldo cifrado, fuera del host y en un servidor estrictamente
controlado.

## Higiene del día a día

- **Mantén pequeño el número de administradores** y revísalo periódicamente. Cada administrador es una
  cuenta de alto valor.
- **Dale a cada automatización su propia cuenta de servicio** con los permisos más estrechos, y rota
  su token si pudo quedar expuesto.
- **Da de baja sin demora.** Como la propiedad y el acceso en lazyit siguen al usuario vivo, quitar a
  una persona elimina limpiamente su alcance.
- **Mantén tu proveedor de identidad parcheado y protegido** — es la puerta de entrada, y lazyit
  confía en él.

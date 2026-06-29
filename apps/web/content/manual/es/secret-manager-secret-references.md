---
title: Referencias a secretos
category: secret-manager
subcategory: secret-references
order: 4
---

# Referencias a secretos

Un artículo de la Base de Conocimiento suele documentar un procedimiento que necesita una credencial —
"inicia sesión con la contraseña del registrador", "usa la clave precompartida de la VPN". En lugar de
pegar el secreto en el artículo (lo que convertiría la Base de Conocimiento en un almacén de secretos
sin protección), lo **referencias**. El artículo muestra una **etiqueta enmascarada** (chip) en lugar
del valor, y solo un miembro de la bóveda puede revelarlo.

## Agregar una referencia

En un artículo de la Base de Conocimiento, referencia un secreto por su **identificador** (handle) con
el token:

```
{{ lazyit_secret.IDENTIFICADOR }}
```

donde `IDENTIFICADOR` es el identificador de un secreto de una de tus bóvedas (por ejemplo,
`{{ lazyit_secret.cloudflare_api_key }}`). El identificador es el nombre del secreto — **no** su valor.
Cuando escribes `{{ lazyit_secret.`, el editor te ofrece los identificadores de los secretos a los que
puedes acceder, para que no tengas que recordarlos. El autocompletado lista **solo identificadores,
nunca valores**.

La referencia se guarda como texto plano en el artículo. No contiene ningún secreto — el valor se
obtiene y se descifra únicamente cuando alguien revela el chip.

## Cómo se comporta el chip para un lector

Al mostrarse el artículo, el token se convierte en un pequeño **chip** en línea. Lo que ve un lector
depende de su acceso:

- **Un chip con llave (revelable).** El lector es miembro de la bóveda del secreto. Al hacer clic en
  **Revelar** (y, si el Gestor de Secretos está bloqueado, ingresar su contraseña) se muestra el valor
  **en línea, en su navegador**. Al hacer clic de nuevo se oculta; **Copiar** lo coloca en el
  portapapeles.
- **Un chip bloqueado.** El lector puede abrir el artículo pero **no** es miembro de la bóveda del
  secreto. Ve el identificador y un candado, y no puede revelar nada.
- **Un chip roto.** El identificador no coincide con ningún secreto actual — por ejemplo, se renombró o
  se eliminó. El chip queda marcado para que un autor pueda corregir la referencia.
- **Un error de descifrado.** El lector es miembro de la bóveda pero el valor no se pudo descifrar — la
  clave de la bóveda es incorrecta, o el valor almacenado está corrupto o alterado. El chip muestra un
  error claro y un **Reintentar**, sin fallar en silencio. Si Reintentar sigue fallando, el valor puede
  haber sido alterado — rota la credencial real y vuelve a agregar el secreto.

## La regla de las dos llaves

Revelar un secreto referenciado requiere acceso a **ambos**:

1. el **artículo** — a través del acceso a su carpeta de la Base de Conocimiento; **y**
2. la **bóveda** del secreto — a través de la membresía de la bóveda.

Por lo tanto, incrustar un secreto en un artículo **nunca amplía quién puede leerlo**. Un lector que
puede abrir el artículo pero no es miembro de la bóveda solo verá un chip bloqueado. Conceder y revocar
el acceso al secreto se sigue haciendo en la bóveda (consulta
[Bóvedas y miembros](/help/secret-manager-vaults-members)), no en el artículo.

## Qué nunca llega al servidor en claro

Cuando se revela un chip, el valor se descifra **en el navegador del lector** — nunca pasa por el
servidor como texto en claro. Es la misma garantía de extremo a extremo que el resto del Gestor de
Secretos: referenciar un secreto desde un artículo no lo hace legible para lazyit. Consulta el
[Modelo de seguridad](/help/secret-manager) para el panorama completo.

# Tablero

> **Esto es un ejemplo, no un proyecto mantenido.** Es una copia del panel que uso a diario, tal como estaba el 23 de octubre de 2026, sin mis datos personales. El repo está archivado: no voy a contestar issues ni a aceptar pull requests, y no va a recibir más cambios. Úsalo como punto de partida o como idea para que tu agente te haga el tuyo.

Es una tablet Android vieja (con Android 8.1) en el escritorio, convertida en el panel de mi día: tareas, calendario, lo que vamos a comer, el tiempo y lo que me queda de Claude y de Codex. Además le puedo hablar: le digo lo que quiero cambiar, me enseña lo que ha entendido y no toca nada hasta que le doy a «Hacerlo».

No he mirado ni una línea del código: salió de 53 mensajes con un agente, en cuatro días de ratos sueltos. La idea viene de los [marcos de fotos de Wes Bos](https://github.com/wesbos/photo-frame-dashboard), que convierte marcos digitales con Android en paneles.

En el vídeo cuento cómo funciona y cómo lo hice: https://youtu.be/sasgoZTgZHQ

## Cómo hacerte el tuyo

Lo más práctico no es instalar esto tal cual, sino dárselo a tu agente (Claude Code, Codex…) y pedirle que lo adapte a lo que tú usas. `AGENTS.md` le explica cómo está organizado el código y qué reglas sigue, y este README explica cada pieza. Ve por partes: primero las tareas, luego el calendario, luego lo demás.

Para verlo funcionando sin configurar nada, con datos inventados:

```bash
demo/demo.sh datos
```

```bash
demo/demo.sh arrancar
```

Y abre http://127.0.0.1:4949. Detalles en «Demo con datos inventados», más abajo.

**Lo que necesita.** Está hecho para mi máquina y casi todo es opcional:

- **Siempre**: un Mac y Node 22 o posterior. No tiene dependencias de npm. El servicio y la demo usan launchd, que es de macOS; en Linux habría que cambiar esa parte.
- **Calendario y bloques de trabajo**: [gog](https://github.com/openclaw/gogcli) con tu cuenta de Google, y en esa cuenta un calendario llamado «Bloques Trabajo» (o el que digas en `TABLERO_BLOQUES`). Sin `TABLERO_CUENTAS` el calendario no se activa.
- **`oprun`**: es mi envoltorio para lanzar comandos con secretos de 1Password, y el tablero llama a gog a través de él. Si no lo usas, apunta `TABLERO_OPRUN` a un script que solo haga `exec "$@"`.
- **Claude y Codex**: [CodexBar](https://github.com/steipete/CodexBar) con `codexbar serve`. Sin él, los anillos no salen.
- **Voz**: `mlx_whisper` (Apple Silicon) y el CLI oficial de `claude` con sesión iniciada en tu suscripción.
- **La tablet**: cualquier tablet con Firefox y `adb` para dejarla en modo kiosco. El tablero también funciona en cualquier navegador del Mac o del móvil.

**Lo que tendrías que cambiar.** Las fichas están en `TAREAS_DIR` (por defecto `~/tablero/tareas`) y las comidas en `COMIDAS_DIR` (por defecto `~/tablero/comidas`). El tiempo es de Madrid salvo que pongas `TABLERO_TIEMPO`. El dueño de las tareas se llama `antonio` en el código (`src/cards.mjs`, `src/server.mjs`, `src/voice.mjs`, `public/tasks.js`), y el texto que recibe Claude para los comandos de voz habla de mí. Todo lo de la pantalla está en español.

## Qué hay

Mi panel del día, pensado para una tablet en la pared y usable también desde el Mac. Un rail lateral de 56 px (solo iconos de 48 px, con la hora abajo) lleva a cuatro paneles:

- **Inicio** (el que se abre por defecto): el día de un vistazo. Ver «Inicio» más abajo.
- **Tareas**: el kanban de las fichas (lo que sigue). El «+» flotante de abajo a la derecha crea una tarea.
- **Calendario**: la semana de Google Calendar (todos los calendarios de las cuentas de `TABLERO_CUENTAS`, incluidos los que tienen importados), con las tareas que tienen `fecha` en su día.
- **Comidas**: qué preparas de comida y de cena de lunes a viernes.

## Inicio

Tres columnas: lo siguiente del calendario (la hora en grande, o «Ahora» y cuándo termina) con la agenda de hoy y mañana justo debajo; el tiempo en un bloque del color del cielo de hoy y las comidas; y lo que queda del plan de Claude y de Codex en anillos (sesión de 5 horas y semana, con cuándo se reinicia cada una) sobre las tareas que piden atención: las que esperan tu OK, las que vencen en 3 días o ya vencieron, y de la bandeja solo las que tienen un motivo para hacerlas ya (revisión que toca, bloque que pasó, planeada para hoy, elegida para esta semana, lleva días esperando…), con ese motivo debajo. Si no hay nada, dice «Nada urgente» y cuántas quedan en la bandeja por planificar (las aparcadas para más adelante no cuentan). En cada anillo (5 horas y semana), una marca señala por dónde irías gastando a ritmo uniforme: si el arco no llega a ella, vas por encima; la línea de debajo dice cuánto en la semana. Los bloques de tareas ya hechas o soltadas no salen ni en lo siguiente ni en la agenda (en el calendario siguen, tachados). Tocar un bloque o una tarea abre su ficha; tocar las comidas lleva a su panel. La agenda sigue lo que cada dispositivo eligió en «Calendarios», así que lo que va de fondo (por ejemplo, los turnos de trabajo de tu pareja) no cuenta como siguiente.

- **Tiempo**: Open-Meteo (gratis y sin clave) para Madrid; `TABLERO_TIEMPO="Nombre|lat|lon"` cambia el sitio. El servidor lo guarda 15 minutos, y la última previsión buena también en `~/.cache/tablero/tiempo.json`, así que una caída de Open-Meteo no deja el bloque vacío ni tras un reinicio.
- **Claude y Codex**: de CodexBar, el mismo que alimenta SketchyBar. El servidor pregunta a `codexbar serve` (`http://127.0.0.1:8080/usage`, `TABLERO_CODEXBAR_URL`) y, si no responde, lee la caché de showy-quota (`~/.cache/showy-quota/usage.json`). No usa credenciales.

Las hojas (fichas, bloques, eventos) se cierran tocando fuera, salvo que tengan cambios sin guardar: entonces avisa y se queda abierta.

**Comandos de voz.** El micro de la barra lateral, encima de la luna: tocas, hablas con naturalidad y vuelves a tocar. Puedes mezclar cosas y corregirte a mitad: «el jueves para cenar pon pizza, resérvame una hora mañana por la mañana para lo de los ponentes y lo del taller pásalo a esperando, que me llaman ellos el miércoles».
Entiende tareas (crear, cambiar título, siguiente paso, fecha o límite, cerrar, soltar, mover de estado, apuntar una nota), el menú (poner, quitar o intercambiar platos) y los bloques de trabajo (reservar, para una tarea o una nueva; mover; quitar). El Mac transcribe en local con Whisper (`mlx_whisper`, large-v3-turbo; el audio no sale de casa) y el `claude` oficial, con tu suscripción (`claude -p` con Haiku, sin herramientas y en modo seguro), lo convierte en un plan, sabiendo qué día es cada fecha de las próximas dos semanas, tus tareas abiertas, el menú de esta semana y la siguiente y tus próximos bloques. A Whisper le pasa los títulos de tus tareas como pista, para que acierte con tus palabras (nombres propios, siglas…). La tablet te lo enseña con lo que ha entendido y sus dudas, y no cambia nada hasta que pulsas «Hacerlo»; entonces lo aplica el servidor, como cualquier otro cambio. Tarda unos 10 segundos. Claude nunca escribe en las tarjetas, y se lanza sin `ANTHROPIC_API_KEY` para que siempre vaya por la suscripción. En la tablet, el micro sobre HTTP necesita dos ajustes de Firefox que pone `scripts/tablet-kiosk.sh aplicar`; la primera vez Firefox pide permiso. `TABLERO_VOZ=0` lo desactiva.

La luna de la barra lateral, encima de la hora (abajo a la derecha en el móvil), cambia entre claro y oscuro en ese dispositivo y lo recuerda; la tablet, con Android 8.1, no tiene modo oscuro del sistema. Sin elegir nada, cada dispositivo sigue al sistema, y si eliges lo mismo que el sistema vuelve a seguirlo.

La página se recarga sola cuando cambian sus ficheros o se reinicia el servidor (el flujo de eventos anuncia una versión), así que la tablet nunca se queda con una versión vieja. Para que ese flujo no muera sin avisar, el servidor manda un latido cada 25 s y la página se reconecta sola si se cierra o pasa 70 s callado (Firefox no reintenta después de un error); después hay que tocarla una vez para volver a pantalla completa.

## Tareas

Cada tarea es una ficha Markdown en `TAREAS_DIR` (`T-NNN.md`, por defecto en `~/tablero/tareas/`), así que Claude, Codex y las tareas programadas la leen y la cambian como cualquier otro fichero. Encima de esas fichas hay dos piezas:

- **`tareas`**: la CLI que usan los agentes (`tareas --help`).
- **El tablero**: un kanban en http://127.0.0.1:4747 que se actualiza solo cuando alguien toca una ficha.

No tiene dependencias: basta con Node 22 o posterior.

## La ficha

```markdown
---
id: T-012
titulo: "Imprenta: pagar la diferencia de 12,40 €"
estado: bandeja
responsable: antonio
siguiente: "Pagar la diferencia desde la página del pedido y avisarles"
area: admin
ambito: pro
limite: 2026-10-23
origen: "Correo de la imprenta, pedido `P-20481`"
creada: 2026-10-16
actualizada: 2026-10-16 18:05
---

## Contexto

Lo que hace falta para retomarla: hilos, enlaces, importes, decisiones.

## Bitácora

- 2026-10-16 18:05 · Claude: Migrada desde tasks.md («Próximos días»)
```

La cabecera es plana (`clave: valor`). El texto libre va entre comillas dobles, como en JSON. En la tarjeta solo se ve la cabecera; el contexto y la bitácora se ven al abrirla. La ficha del tablero solo enseña los campos que tienen sentido en cada estado: fecha límite y área siempre, «¿Cuándo la vuelves a mirar?» (`revisar`) en Esperando y Más adelante, y «¿A quién esperas?» (`responsable`) en Esperando. `fecha` no se edita a mano: la ponen los bloques.

| Campo | Para qué |
| --- | --- |
| `estado` | `bandeja`, `semana`, `en-curso`, `agente`, `tu-ok`, `esperando`, `mas-adelante`, `hecha`, `soltada` |
| `responsable` | `antonio`, `agente` o la persona a la que esperas |
| `siguiente` | el siguiente paso, en una línea |
| `fecha` | el día en que está planificada |
| `limite` | la fecha límite externa (`AAAA-MM-DD` o `AAAA-MM-DD HH:MM`) |
| `revisar` | cuándo vuelve a mirarse una tarea que espera o que está para más adelante |
| `agente` | quién la ha cogido cuando está en Agente |
| `evidencia` | qué demuestra que está hecha |

## Columnas

Bandeja · Planificado · En curso · Agente · Necesita tu OK · Esperando.

- **Planificado** no es un estado de la ficha: es cualquier tarea de la bandeja con un bloque en «Bloques Trabajo» que aún no ha terminado (ver Bloques de trabajo). Arrastrar una tarea aquí abre la hoja para reservarle hueco; sacarla a la Bandeja quita sus bloques pendientes. Si todos sus bloques pasan sin cerrarla, vuelve sola a la Bandeja, arriba.
- **Bandeja** tiene todo lo demás, incluido lo que está para más adelante (atenuado y abajo hasta que se acerque su fecha de `revisar`), en el orden recomendado. El servidor puntúa cada tarjeta (`src/priority.mjs`): fecha límite vencida o cercana, revisión pendiente, bloque que se pasó, elegida para esta semana (estado `semana`), fecha planeada y días esperando. El motivo principal se ve al pasar por encima y en la ficha («Prioridad»).
- Los estados `semana` y `mas-adelante` siguen existiendo en las fichas y en la CLI; en el tablero solo cambian el orden de la Bandeja.
- Lo cerrado (hecho o soltado) no se ve en el tablero: se cierra con la casilla de la tarjeta (con unos segundos para deshacer) o desde la ficha. Las fichas no se borran: siguen en disco para la CLI y los agentes (`tareas resumen` muestra las de las últimas dos semanas y `tareas lista --todo`, todas).
- **Agente**: lo que delegas. Un agente lo coge con `tareas coger`, apunta en la bitácora lo que hace y la cierra o la deja en **Necesita tu OK** si el siguiente paso no tiene vuelta atrás (enviar, publicar, pagar o firmar).

## La CLI

```bash
tareas resumen
```

```bash
tareas nueva "Título corto" --siguiente "Primer paso" --area admin --quien claude
```

```bash
tareas mover T-012 esperando --responsable "Imprenta" --revisar 2026-10-23 --quien claude
```

También están `lista`, `ver`, `editar`, `nota`, `coger`, `cerrar`, `soltar` y `ruta`. Las fichas están en `TAREAS_DIR` (por defecto `~/tablero/tareas`).

## Calendario

Solo lectura. El servidor lanza `oprun gog -a <cuenta> calendar events --all` por cada cuenta (`TABLERO_CUENTAS`, separadas por comas; los calendarios de otras cuentas se ven si están importados en ellas), junta los eventos y quita duplicados (la misma reunión en varios calendarios).

- **Cuatro semanas por llamada**: cada consulta trae la semana pedida, la anterior y las dos siguientes. Cuesta lo mismo que una sola (casi todo el tiempo, unos 3 s, es arrancar gog y 1Password), así que moverse a las semanas vecinas no espera a Google. Al arrancar, el servidor ya pide la semana actual.
- **Caché en memoria**: una semana de menos de 5 minutos se sirve tal cual; de hasta una hora, también, mientras se pide de nuevo por detrás; si al llegar ha cambiado algo, el servidor avisa (`calendario`) y las pantallas la vuelven a pedir. Más vieja que una hora (el Mac ha dormido), espera a Google. Escribir un bloque desde el tablero vacía la caché.
- **En la página** (`public/weeks.js`): el calendario y el inicio comparten las semanas ya vistas, así que una semana conocida se pinta al momento mientras se pregunta al servidor, y al terminar se piden por adelantado la anterior y la siguiente. Cada semana lleva una huella: si no cambia, no se vuelve a dibujar.
- «Actualizar» se salta las cachés y vuelve a leer la lista de calendarios (nombres, colores, altas y bajas), que si no se refresca cada 6 horas.

- Los eventos marcados como *libres* en Google (festivos…) salen rayados: no bloquean la agenda.
- Los cumpleaños de contactos (de día completo) no se muestran; una fiesta con hora sí.
- Las tareas con `fecha` aparecen en la fila «Día» de ese día; tocarlas abre la ficha.
- **Bloques de trabajo**: tocar una hora libre reserva un bloque para una tarea (o «Reservar hueco» desde la ficha). Ver abajo.
- Ocupa toda la pantalla, sin barra ni marco: el ⋮ de la esquina despliega hoy, semana anterior y siguiente, actualizar y calendarios (se resalta si no estás en la semana actual), y el mes va en la esquina de la fila «Día». Se cambia de semana deslizando a los lados (al soltar aparece la otra semana; nada se mueve con el dedo, ver «Tablet de pared»), o con las flechas en el Mac. En pantallas bajas como la tablet, la hora es más alta (56 px), el texto más pequeño y los eventos cortos solo llevan el título.
- Cada evento lleva un borde fino de su color; los bloques de trabajo, discontinuo. Si el mismo evento se ve desde dos calendarios (mismo identificador de Google), sale una vez; dos eventos distintos salen siempre, aunque se llamen igual.
- «Calendarios» deja elegir, en ese dispositivo, cómo se ve cada calendario: **Ver**, **Fondo** (una franja tintada detrás de los eventos que no ocupa sitio ni impide reservar bloques encima) u **Ocultar**. `TABLERO_FONDO` (nombres separados por comas) dice cuáles van de fondo si el dispositivo no ha elegido nada.
- En pantallas estrechas se ve un día con una tira de días arriba. Deslizar cambia de semana (o de día).

## Bloques de trabajo

Un bloque es tiempo reservado para una tarea. Vive en Google, en el calendario «Bloques Trabajo» (`TABLERO_BLOQUES` para usar otro nombre), como evento **libre**: se ve en el móvil pero no bloquea a nadie que quiera reservarte una cita.

- Google manda: si lo mueves desde Google Calendar, el tablero lo ve ahí (en cuanto refresca, unos 5 minutos, o con «Actualizar»). La ficha no guarda la hora; el enlace es la propiedad privada `tarea=T-012` del evento.
- Crear o mover un bloque desde el tablero pone la `fecha` de la ficha en ese día.
- Si al reservar escribes algo que no es ninguna tarea abierta, «Crear «…»» (o Intro) crea la tarea con ese bloque: en Esta semana si el bloque cae esta semana, en la Bandeja si es más adelante.
- Tocar un bloque permite moverlo, cambiar su duración, quitarlo, abrir la tarea o marcarla como hecha sin pasar por su ficha (con unos segundos para deshacer; el bloque se queda, tachado). En la ficha, «Bloques de trabajo» lista los próximos.
- Al cerrar la tarea, sus bloques se quedan en el calendario, tachados.

## Comidas

Solo de lunes a viernes: los fines de semana no se planifican, y el sábado y el domingo el panel abre ya la semana siguiente. Un fichero por semana en `COMIDAS_DIR` (por defecto `~/tablero/comidas`), con el nombre del lunes:

```markdown
# Comidas · semana del 19/10/2026

## Lunes 19/10 · 2026-10-19

- Comida: Lentejas con verduras
- Cena: Tortilla
```

Se puede editar a mano o desde un agente: el panel lee cada `## … AAAA-MM-DD` y sus líneas `- Comida:` / `- Cena:`, y se refresca solo cuando cambia el fichero. Al tocar un hueco salen los platos ya usados para rellenarlo con un toque. Para mover un plato, arrástralo a otro hueco (con el dedo, mantenlo pulsado un momento antes); si el destino ya tenía algo, se intercambian.

## Arrancar el tablero

```bash
node bin/tablero.mjs
```

Variables: `TABLERO_PORT` (4747), `TABLERO_HOST` (127.0.0.1; el servicio usa 0.0.0.0), `TABLERO_HOSTS` (nombres de host extra permitidos, separados por comas), `TABLERO_CLAVE_FILE` (clave de otros dispositivos, por defecto `~/.config/tablero/clave`), `TAREAS_DIR`, `COMIDAS_DIR`, `TABLERO_CUENTAS` (cuentas de Google separadas por comas), `TABLERO_OPRUN` (ruta de `oprun`), `TABLERO_TIEMPO` (`Nombre|lat|lon`), `TABLERO_FONDO`, `TABLERO_BLOQUES` (nombre del calendario de bloques) y `TABLERO_CALENDARIO=0` para desactivar el calendario.

Para que arranque al iniciar sesión, `scripts/instalar-servicio.sh` crea un LaunchAgent (`io.devexpert.tablero`, logs en `~/Library/Logs/tablero/`). Escucha en todas las interfaces para que llegue la tablet por Wi-Fi, y la primera vez crea la clave de otros dispositivos. Copia al servicio las variables `TABLERO_*`, `TAREAS_DIR` y `COMIDAS_DIR` que tengas en la terminal al lanzarlo. Si las fichas están en Documentos, la primera vez macOS puede pedir permiso para que `node` lea esa carpeta.

Desde el móvil, `tailscale serve --bg 4747` publica el tablero solo dentro de tu tailnet (`https://<tu-mac>.<tailnet>.ts.net`).

Para tenerlo en el Dock como una app, ábrelo en Safari y usa Archivo → Añadir al Dock. Toma el nombre y el icono de `public/manifest.webmanifest`; los PNG se regeneran con `scripts/generar-iconos.py`.

## Tablet de pared (kiosco)

La tablet es una «Tab_9» genérica (MediaTek MT6750, Android 8.1, sin cuenta de Google) conectada al Wi-Fi de casa. Lleva Firefox, porque Chrome no pasa de la versión 64 sin Play Store y no puede con el tablero, y lo abre a pantalla completa contra el Mac.

1. **Firefox**: APK oficial de Mozilla (`https://archive.mozilla.org/pub/fenix/releases/<versión>/android/`, variante `arm64-v8a`), instalado con `adb install -r`. Su certificado tiene que ser el de Mozilla (SHA-256 `A7:8B:62:A5:…:EA:31:9B:04`). No se actualiza solo: para actualizarlo, se repite con la versión nueva.
2. **Ajustes**: `scripts/tablet-kiosk.sh aplicar` desactiva (no borra) las apps del fabricante y las preinstaladas y, con Firefox ya instalado, también Chrome, la Play Store y los servicios de Google. Además deja la pantalla siempre encendida mientras esté enchufada, en horizontal, sin salvapantallas, animaciones ni barras del sistema sobre Firefox, y con el renderizado por software de Firefox. El de la GPU va unas tres veces más fluido en esta tablet (medido en octubre de 2026: ~30 fps frente a 7-14 al deslizar el calendario), pero su driver dibuja mal todo lo que pasa por una capa intermedia: con `opacity`, `will-change` o animaciones, hay elementos que no se pintan o no se mueven y esquinas con muescas cuadradas. Ni siquiera con el tablero plano (sin nada de eso): al desplazar, a algunos eventos les falta el fondo o les sale una barra gris. Firefox ya aplica los apaños conocidos para estas GPUs (Mali-T) y no hay ajuste que lo arregle. El tablero se queda plano de todas formas, porque con software también le cuesta menos pintar. `deshacer` lo revierte y `estado` lo muestra. La zona horaria (Madrid) y el idioma (español) se eligieron a mano en Ajustes, porque adb no puede cambiarlos en esta tablet.
3. **Emparejarla**: `scripts/tablet-kiosk.sh enlace` abre el tablero en Firefox con la clave de `~/.config/tablero/clave`. El servidor la guarda como cookie y la quita de la URL, y el `?kiosco=1` hace que la página se ponga a pantalla completa con el primer toque. Para salir: deslizar desde arriba y Atrás.

Cosas a saber:

- Si se va la luz, Firefox no arranca solo: se abre con su icono y se toca una vez la pantalla.
- La tablet apunta a la IP del Mac. Conviene reservarla en el router; si cambia, se vuelve a lanzar `enlace`.
- Si el Mac duerme, el panel se queda con lo último que cargó y se pone al día solo al volver.
- Para sacar un dispositivo emparejado, se cambia la clave (`trash ~/.config/tablero/clave` y `scripts/instalar-servicio.sh`) y se vuelve a emparejar la tablet.

## Seguridad

- Escucha en todas las interfaces, pero solo el propio Mac entra sin más (loopback, y `tailscale serve`, que llega por loopback). Cualquier otro dispositivo necesita la clave de `~/.config/tablero/clave` en una cookie; sin ella recibe un 401. Sin fichero de clave, solo entra el Mac.
- Solo acepta cabeceras `Host` de loopback, `*.ts.net` o IPs privadas (una web de DNS rebinding manda su propio dominio, nunca una IP), para evitar DNS rebinding.
- Para escribir hace falta JSON, la cabecera `X-Tablero: 1` y un `Origin` igual al `Host` de la petición, así que otra web abierta en el navegador no puede mover tarjetas.
- Si la ficha ha cambiado desde que la abriste (por ejemplo, porque la ha movido un agente), el cambio se rechaza con un 409 y la página se recarga.
- La página tiene una CSP estricta y el Markdown se escapa antes de pintarse.

## Demo con datos inventados

Para vídeos y capturas, `demo/` levanta un segundo tablero en el puerto 4949 con tareas, calendario, comidas y uso de IA inventados. Corre al lado del real y no lo toca.

- `demo/demo.sh datos [AAAA-MM-DD]` crea los datos alrededor de ese día (hoy, si no pones ninguno) en `demo/datos/`, fuera de git. Empieza de cero cada vez, y si la demo está en marcha la reinicia.
- `demo/demo.sh arrancar`, `parar` y `estado`. La demo corre como un trabajo de launchd (`io.devexpert.tablero-demo`) con el entorno limpio, como el servicio real, y no arranca sola al iniciar sesión.
- `demo/demo.sh tablet` abre la demo en la tablet, y `volver` pone otra vez el tablero real. No hay que emparejar nada: la demo usa la misma clave de dispositivo, y la tablet ya la tiene en su cookie (las cookies no dependen del puerto). Después, un toque para la pantalla completa.
- `demo/demo.sh terminal` abre una terminal donde `tareas`, y cualquier agente que lances desde ella, trabajan sobre las tareas de la demo.

Qué es de verdad y qué no:

- Google es `demo/fake-oprun.mjs`: responde desde `demo/datos/google.json` y guarda lo que escribes, así que los bloques se reservan, se mueven y se quitan como en el real.
- Los límites de Claude y Codex los inventa `demo/servidor.mjs` a partir de la hora, para que no se queden viejos.
- El tiempo es el real, de Madrid.
- La voz es la de verdad (Whisper y `claude -p` con tu suscripción), sobre las tareas, el menú y los bloques de la demo.

## Desarrollo

```bash
npm test
```

# La fábrica de software — simulador

Una semana como responsable de una fábrica de software: la máquina trabaja 168
horas, tú tienes 40 y decides para qué son. No escribes código — los agentes lo
escriben. Lo tuyo es decidir qué entra, qué se queda fuera, qué lees y qué
apruebas sin leer.

Se juega en el navegador, no necesita instalar nada: abre `index.html`.

## Qué hay aquí

- `index.html` — el simulador entero en un archivo, listo para abrir.
- `src/` — las mismas fuentes sin empaquetar, por si quieres leerlas:
  - `engine/tuning.mjs` — **todos los números** en un solo sitio: cuánto cuesta
    revisar un plan, cuánto una entrega, cuánto se equivocan las estimaciones,
    qué etapas son delegables. Público a propósito.
  - `engine/model.mjs` — las etapas, los defectos y las puertas que los cazan.
  - `engine/engine.mjs` — el bucle de la semana.
  - `engine/calendar.mjs` — los dos calendarios: el de la máquina y el tuyo.
  - `ui/` — el lienzo, la pantalla de plan y la de la semana corriendo.

## El bucle

1. **Lunes, antes de abrir.** Repartes las etapas (quién escribe el plan, quién
   revisa, quién prueba a mano), colocas tus 40 horas en bloques, dejas tarjetas
   fuera si no caben, y sellas el plan. El plan sellado lleva hash.
2. **La semana corre** — unos 30 segundos reales. Los agentes trabajan; se paran
   cuando necesitan que mires algo. Entran incidencias, CI en rojo, una decisión
   de producto y alguna cosa que no es como te la cuentan.
3. **El informe.** Lo estimado contra lo real, lo que salió, lo que se rompió, lo
   que quedó a medias, las horas que la máquina pasó esperándote, y las horas de
   trabajo que la semana no contenía y que arregla otro.

## Lo que mide

Nada de velocidad tecleando. Mide **criterio bajo escasez**: qué dejas fuera y
por qué, si preguntas antes de asumir, qué decides no leer, y si lo que delegas
se puede delegar. Hay tres etapas marcadas `delegable: false` — revisar el plan,
revisar la entrega y probar a mano. El juego te deja dárselas a un agente igual;
el informe lo dice.

Una advertencia que el propio simulador te hace en pantalla: **registra lo que
haces** — cada decisión, cuándo la tomas, cuánto tardas, y si el texto de las
cajas lo escribes o lo pegas. No lee tu pantalla, tu portapapeles ni otras
pestañas. El código está aquí; si lo abres, dilo, no resta.

## Práctica

Hay dos rondas de práctica antes de la que cuenta (una tarea y tres tareas).
Las de práctica no puntúan y no envían nada. Repítelas las veces que quieras;
la ronda que cuenta se juega una vez.

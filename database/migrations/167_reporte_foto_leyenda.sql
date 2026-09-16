-- 167_reporte_foto_leyenda.sql
-- La leyenda de cada foto del reporte diario.
--
-- Lo pidió Ivan el 2026-09-15: «poder escribirle un texto a cada foto». Es
-- opcional. Sale debajo de la foto en la pantalla del reporte y en el PDF que va
-- por correo, donde reemplaza al nombre del archivo, que no le decía nada a
-- nadie («image.jpg» desde un iPhone). Cambiarla después de enviar el reporte es
-- una corrección como cualquier otra.
--
-- 150 caracteres: caben en unos tres renglones debajo de la foto del PDF sin
-- que las cuatro fotos verticales dejen de caber en una hoja. El servidor lo
-- comprueba antes con un mensaje que se entiende; esto es la red de abajo.
-- La pantalla usa el mismo tope (LEYENDA_MAX en tipos.ts).
--
-- NULL es «sin leyenda». Una leyenda en blanco se guarda como NULL.
ALTER TABLE proyecto_reporte_fotos
  ADD COLUMN IF NOT EXISTS leyenda VARCHAR(150);

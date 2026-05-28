-- 127_reformat_legacy_edicion_comentarios.sql
--
-- Older edicion comentarios were composed with raw values, producing
-- entries like:
--   monto_total: 345634.00 -> 989370.79,
--   periodo_inicio: Mon Jul 28 2025 00:00:00 GMT+0000 (Coordinated
--     Universal Time) -> 2025-07-29
-- The endpoint was fixed going forward (Spanish labels, DD/MM/YYYY dates).
-- This migration rewrites existing rows so the historial reads cleanly.

DO $$
DECLARE
  r        RECORD;
  new_text TEXT;
BEGIN
  FOR r IN
    SELECT id, comentario
    FROM cuentas_eventos
    WHERE tipo = 'edicion' AND comentario IS NOT NULL
  LOOP
    new_text := r.comentario;

    -- Date.toString() ("Day Mon DD YYYY HH:MM:SS GMT+ZZZZ (TZ)") -> "DD/MM/YYYY"
    new_text := regexp_replace(new_text, '\w{3} Jan (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/01/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Feb (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/02/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Mar (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/03/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Apr (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/04/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} May (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/05/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Jun (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/06/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Jul (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/07/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Aug (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/08/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Sep (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/09/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Oct (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/10/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Nov (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/11/\2', 'g');
    new_text := regexp_replace(new_text, '\w{3} Dec (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT\+\d+ \([^)]+\)', '\1/12/\2', 'g');

    -- ISO "YYYY-MM-DD" -> "DD/MM/YYYY"
    new_text := regexp_replace(new_text, '(\d{4})-(\d{2})-(\d{2})', '\3/\2/\1', 'g');

    -- Pad single-digit days
    new_text := regexp_replace(new_text, '\m(\d)/(\d{2})/(\d{4})\M', '0\1/\2/\3', 'g');

    -- English field labels -> Spanish
    new_text := replace(new_text, 'monto_total:',       'Monto:');
    new_text := replace(new_text, 'periodo_inicio:',    'Período inicio:');
    new_text := replace(new_text, 'periodo_fin:',       'Período fin:');
    new_text := replace(new_text, 'avance_porcentaje:', 'Avance:');
    new_text := replace(new_text, 'es_final:',          'Cuenta final:');

    IF new_text != r.comentario THEN
      UPDATE cuentas_eventos SET comentario = new_text WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

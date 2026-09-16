-- 166_reporte_correcciones_historicas.sql
-- Las correcciones de verdad de antes de la 164 pasan a su lista.
--
-- Hasta la 164 la sección Correcciones salía de audit_log, y ahí se mezclaban
-- las correcciones con las fotos que se suben al enviar. Aquí se copian solo
-- las correcciones: las filas 'editar' con cambios de campos, hechas DESPUÉS del
-- primer 'enviar' de su reporte. Lo de antes del envío no corregía nada.
--
-- Al 2026-09-16 en producción eso es una sola fila: la 2093, cuando Cesar
-- agregó un renglón a Trabajo ejecutado de RD-PBR-260915, a las 9:04 pm del 15
-- de septiembre (hora de Panamá). Las 40 líneas de fotos subidas antes del
-- envío no se copian, y por eso dejan de verse en la pantalla y en los PDF que
-- se generen desde ahora. Los PDF que ya salieron por correo y los archivados
-- en R2 se quedan como están.
--
-- No hay filas con cambios en reportes sin 'enviar': los reportes de antes de
-- que existiera el envío no se corrigieron. Si alguna apareciera, se queda
-- fuera, igual que las de antes del envío.
--
-- audit_log no se toca.
INSERT INTO proyecto_reporte_correcciones
  (reporte_id, clave, creado_por, cambios, pdf_version, created_at, updated_at)
SELECT al.entidad_id,
       NULL,
       al.user_id,
       al.detalles -> 'cambios',
       -- La versión que archivó la corrección en su momento: la primera
       -- archivada desde entonces. Sin ella, queda pendiente y la archiva el
       -- cron de la madrugada.
       (SELECT min(p.version)
          FROM proyecto_reporte_pdfs p
         WHERE p.reporte_id = al.entidad_id
           AND p.created_at >= al.created_at),
       al.created_at,
       al.created_at
  FROM audit_log al
  JOIN (
    SELECT entidad_id, min(created_at) AS primer_envio
      FROM audit_log
     WHERE entidad = 'reporte_diario' AND accion = 'enviar'
     GROUP BY entidad_id
  ) envio ON envio.entidad_id = al.entidad_id
 WHERE al.entidad = 'reporte_diario'
   AND al.accion = 'editar'
   AND al.detalles ? 'cambios'
   AND al.created_at > envio.primer_envio
   -- Por si llegara a correr dos veces.
   AND NOT EXISTS (
     SELECT 1 FROM proyecto_reporte_correcciones c
      WHERE c.reporte_id = al.entidad_id AND c.created_at = al.created_at
   )
 ORDER BY al.created_at;

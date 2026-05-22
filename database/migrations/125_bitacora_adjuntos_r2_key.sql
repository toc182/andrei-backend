-- 125_bitacora_adjuntos_r2_key.sql
-- Renames proyecto_bitacora_adjuntos.ruta_archivo -> r2_key as part of
-- migrating bitacora photo storage from local disk to Cloudflare R2.
-- Matches the naming convention used by solicitud_pago_adjuntos.r2_key.
-- Old rows keep their filename-only values; they are already broken
-- because the previous disk path mismatch (issue #63) prevented serving
-- them. New uploads from this point on store actual R2 keys.

ALTER TABLE proyecto_bitacora_adjuntos RENAME COLUMN ruta_archivo TO r2_key;

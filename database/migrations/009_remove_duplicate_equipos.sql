-- Migration 009: Remove duplicate equipos added in migration 007
-- Date: 2025-09-20

-- Remove the extra Pala 20 Ton (should be 2, not 3)
-- Keep the first two, remove the last one added
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Pala 20 Ton'
    AND marca = 'Caterpillar'
    AND modelo = '320 GX'
    AND ano = 2024
    AND owner = 'COCP'
  ORDER BY id DESC
  LIMIT 1
);

-- Remove duplicate Pala 22 Ton (should be 1, not 2)
-- Keep the original, remove the duplicate
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Pala 22 Ton'
    AND marca = 'Shantui'
    AND modelo = 'SE220LC'
    AND ano = 2025
    AND owner = 'COCP'
  ORDER BY id DESC
  LIMIT 1
);

-- Remove duplicate Rola Vibratoria 12P5 (should be 1, not 2)
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Rola Vibratoria 12P5'
    AND marca = 'Shantui'
    AND modelo = 'SR12P-5'
    AND ano = 2024
    AND owner = 'COCP'
  ORDER BY id DESC
  LIMIT 1
);

-- Remove duplicate Rola Rompe Pecho (should be 1, not 2)
DELETE FROM equipos
WHERE id IN (
  SELECT id FROM equipos
  WHERE descripcion = 'Rola Rompe Pecho'
    AND marca = 'Shantui'
    AND modelo = 'AEPR 500L'
    AND ano = 2023
    AND owner = 'COCP'
  ORDER BY id DESC
  LIMIT 1
);
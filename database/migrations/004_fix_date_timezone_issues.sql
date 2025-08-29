-- Fix timezone issues by converting DATE fields to VARCHAR
-- This prevents PostgreSQL from converting dates to timezone-aware values

-- Update proyectos table
ALTER TABLE proyectos 
  ALTER COLUMN fecha_inicio TYPE VARCHAR(10),
  ALTER COLUMN fecha_fin_estimada TYPE VARCHAR(10);

-- Update licitaciones table  
ALTER TABLE licitaciones
  ALTER COLUMN fecha_cierre TYPE VARCHAR(10),
  ALTER COLUMN fecha_apertura TYPE VARCHAR(10);

-- Update oportunidades table
ALTER TABLE oportunidades
  ALTER COLUMN fecha_contacto_inicial TYPE VARCHAR(10),
  ALTER COLUMN fecha_estimada_cierre TYPE VARCHAR(10),
  ALTER COLUMN fecha_siguiente_seguimiento TYPE VARCHAR(10);

-- Update adendas table
ALTER TABLE adendas
  ALTER COLUMN nueva_fecha_fin TYPE VARCHAR(10),
  ALTER COLUMN fecha_solicitud TYPE VARCHAR(10),
  ALTER COLUMN fecha_aprobacion TYPE VARCHAR(10);
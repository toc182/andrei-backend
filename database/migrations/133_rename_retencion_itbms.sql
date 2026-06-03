-- 133_rename_retencion_itbms.sql
--
-- Normalize legacy "Retención itbms" wording to the canonical
-- "Retención ITBMS 50%" introduced with the global ajuste options
-- in migration 132.
--
-- cuenta_ajustes: historical line items get the new wording so the
-- cuenta detail page reads consistently.
--
-- cuenta_ajuste_opciones: any per-project preset row with the old
-- wording is removed rather than renamed — the global option now
-- covers it, so keeping a per-project copy would duplicate the
-- option in the dropdown.

UPDATE cuenta_ajustes
SET descripcion = 'Retención ITBMS 50%'
WHERE descripcion = 'Retención itbms';

DELETE FROM cuenta_ajuste_opciones
WHERE descripcion = 'Retención itbms';

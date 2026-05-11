-- 103_missing_fk_indexes.sql
-- Cycle A of audit closeout (covers M10-M16 plus extras discovered in
-- information_schema: every FK column without an index gets one).
-- 46 indexes total. All idempotent (CREATE INDEX IF NOT EXISTS).
-- Source query: pg_constraint LEFT JOIN pg_index, 2026-05-11.

CREATE INDEX IF NOT EXISTS idx_cajas_menudas_creado_por ON cajas_menudas(creado_por);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_solicitud_apertura_id ON cajas_menudas(solicitud_apertura_id);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_adjuntos_solicitud_reembolso_id ON cajas_menudas_adjuntos(solicitud_reembolso_id);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_adjuntos_subido_por ON cajas_menudas_adjuntos(subido_por);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_gastos_registrado_por ON cajas_menudas_gastos(registrado_por);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_gastos_solicitud_reembolso_id ON cajas_menudas_gastos(solicitud_reembolso_id);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_historial_monto_cambiado_por ON cajas_menudas_historial_monto(cambiado_por);
CREATE INDEX IF NOT EXISTS idx_cajas_menudas_historial_monto_solicitud_id ON cajas_menudas_historial_monto(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_categorias_presupuesto_proyecto_categoria_id ON categorias_presupuesto(proyecto_categoria_id);
CREATE INDEX IF NOT EXISTS idx_comprobantes_pago_registrado_por ON comprobantes_pago(registrado_por);
CREATE INDEX IF NOT EXISTS idx_contactos_externos_creado_por ON contactos_externos(creado_por);
CREATE INDEX IF NOT EXISTS idx_correcciones_solicitud_user_id ON correcciones_solicitud(user_id);
CREATE INDEX IF NOT EXISTS idx_cuentas_creado_por ON cuentas(creado_por);
CREATE INDEX IF NOT EXISTS idx_cuentas_adjuntos_subido_por ON cuentas_adjuntos(subido_por);
CREATE INDEX IF NOT EXISTS idx_cuentas_eventos_creado_por ON cuentas_eventos(creado_por);
CREATE INDEX IF NOT EXISTS idx_cuentas_eventos_cuenta_id ON cuentas_eventos(cuenta_id);
CREATE INDEX IF NOT EXISTS idx_cuentas_ipt_creado_por ON cuentas_ipt(creado_por);
CREATE INDEX IF NOT EXISTS idx_cuentas_ipt_firma_contralor_por ON cuentas_ipt(firma_contralor_por);
CREATE INDEX IF NOT EXISTS idx_cuentas_ipt_firma_mef_por ON cuentas_ipt(firma_mef_por);
CREATE INDEX IF NOT EXISTS idx_cuentas_ipt_firma_ministro_por ON cuentas_ipt(firma_ministro_por);
CREATE INDEX IF NOT EXISTS idx_devoluciones_solicitud_registrado_por ON devoluciones_solicitud(registrado_por);
CREATE INDEX IF NOT EXISTS idx_facturas_solicitud_registrado_por ON facturas_solicitud(registrado_por);
CREATE INDEX IF NOT EXISTS idx_licitaciones_creado_por ON licitaciones(creado_por);
CREATE INDEX IF NOT EXISTS idx_licitaciones_presentada_por ON licitaciones(presentada_por);
CREATE INDEX IF NOT EXISTS idx_oportunidades_asignado_a ON oportunidades(asignado_a);
CREATE INDEX IF NOT EXISTS idx_oportunidades_creado_por ON oportunidades(creado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_ajustes_aprobacion_user_id ON proyecto_ajustes_aprobacion(user_id);
CREATE INDEX IF NOT EXISTS idx_proyecto_bitacora_creado_por ON proyecto_bitacora(creado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_bitacora_comentarios_creado_por ON proyecto_bitacora_comentarios(creado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_categorias_gastos_categoria_id ON proyecto_categorias_gastos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_proyecto_gastos_aprobado_por ON proyecto_gastos(aprobado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_gastos_creado_por ON proyecto_gastos(creado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_presupuestos_actualizado_por ON proyecto_presupuestos(actualizado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_presupuestos_creado_por ON proyecto_presupuestos(creado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_tareas_categoria_id ON proyecto_tareas(categoria_id);
CREATE INDEX IF NOT EXISTS idx_proyecto_tareas_completado_por ON proyecto_tareas(completado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_tareas_creado_por ON proyecto_tareas(creado_por);
CREATE INDEX IF NOT EXISTS idx_proyecto_tareas_comentarios_user_id ON proyecto_tareas_comentarios(user_id);
CREATE INDEX IF NOT EXISTS idx_reembolsos_pinellas_registrado_por ON reembolsos_pinellas(registrado_por);
CREATE INDEX IF NOT EXISTS idx_requisiciones_archivado_por ON requisiciones(archivado_por);
CREATE INDEX IF NOT EXISTS idx_requisiciones_expense_id ON requisiciones(expense_id);
CREATE INDEX IF NOT EXISTS idx_requisiciones_pagado_por ON requisiciones(pagado_por);
CREATE INDEX IF NOT EXISTS idx_requisiciones_historial_usuario_id ON requisiciones_historial(usuario_id);
CREATE INDEX IF NOT EXISTS idx_solicitud_aprobaciones_user_id ON solicitud_aprobaciones(user_id);
CREATE INDEX IF NOT EXISTS idx_solicitud_pago_adjuntos_subido_por ON solicitud_pago_adjuntos(subido_por);
CREATE INDEX IF NOT EXISTS idx_user_project_access_proyecto_id ON user_project_access(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_user_project_access_user_id ON user_project_access(user_id);
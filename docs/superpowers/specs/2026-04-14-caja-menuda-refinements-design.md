# Caja Menuda — UI/UX Refinements and Cierre Logic Rework

## Problem

After implementing apertura solicitudes (#43), testing revealed several UI/UX issues and a fundamental flaw in the cierre logic that makes zero-balance closure impossible.

## Changes

### 1. Alert Alignment Fix

The red alert banner in CajaMenudaDetail for pending apertura transferencia has misaligned icon and text. Fix the vertical alignment so icon and text are properly centered.

### 2. "Transferida" → "Verificada" (Blue Badge)

- Database value stays `transferida` — no migration needed
- Display label changes to **"Verificada"** everywhere
- Badge color changes from teal to **blue** (matching `facturada` style)
- Affects: EstadoBadge.tsx, ESTADO_OPTIONS in types.ts, SolicitudPaymentStatusCards.tsx, RegistrarPagoDialog.tsx

### 3. Transfer Comprobante Visibility Bug

After registering a transfer on an apertura solicitud, the uploaded comprobante does not appear in the solicitud detail. The `SolicitudPaymentStatusCards` condition was updated to include `transferida`, but the comprobante data may not be loading. Investigate and fix.

### 4. Gear Dropdown + 4 Separate Modals

Replace the pencil icon in the caja table rows with a **gear icon** that opens a shadcn `DropdownMenu`. Each action opens its own focused modal:

| Action | Icon | Modal Fields |
|--------|------|-------------|
| **Editar** | Pencil | Name, Responsible only |
| **Subir monto** | Plus (green) | New amount (must be > current). Info text: "Se creará una solicitud de apertura automática por la diferencia." |
| **Bajar monto** | Minus (red) | New amount (must be < current). Optional comprobante upload. |
| **Cerrar Caja Menuda** | Lock | Comprobante upload (saldo > 0) or auto-constancia message (saldo = 0) |

Separator between Editar and the monto actions. Separator between monto actions and Cerrar.

**"Cerrar Caja Menuda" disabled state:** When the caja has a pending (non-reembolsada) reembolso solicitud, the option is grayed out with a tooltip: "Tiene solicitud de reembolso pendiente".

The current single-modal code in CajasMenudasPage.tsx is removed and replaced with 4 dialog components.

- Editar calls `PUT /:id` (name, responsible only)
- Subir monto calls `PUT /:id/monto`
- Bajar monto calls `PUT /:id/monto` with optional comprobante
- Cerrar calls `PUT /:id` with `estado: 'cerrada'` and optional comprobante

### 5. Cierre Logic Rework

**Current behavior (wrong):** Closing is blocked if there are ANY expenses not linked to a fully reembolsada solicitud. This makes zero-balance closure impossible.

**New behavior (3 rules):**

1. **Expenses exist, no reembolso requested** — User can close. Expenses stay as history. Saldo = 0 → auto-PDF. Saldo > 0 → comprobante required.

2. **A reembolso solicitud exists but hasn't been fully paid** — User CANNOT close. The dropdown option is grayed out. They must wait for the reembolso to be paid, or delete the solicitud first.

3. **Reembolso fully paid** — User can close normally (same as rule 1).

**Backend change:** Replace the current blanket "pending gastos" check in the PUT /:id handler with a check for non-reembolsada reembolso solicitudes only. Unlinked gastos are not a blocker.

**Frontend change:** The backend list/project GET endpoints return a `tiene_reembolso_pendiente` flag so the frontend can disable the "Cerrar" option in the dropdown.

### 6. Historial de Monto — Simplified Table

**Single "Monto" column** instead of separate "Anterior" and "Nuevo" columns. Each row shows what the amount was changed to. The previous amount is implied by the row above.

**Initial row:** The first row shows the original monto_asignado from caja creation (date: created_at, monto: original amount, por: creator). This is a synthetic row added in the frontend — no backend change needed.

Example:

| Fecha | Monto | Por | Comprobante |
|-------|-------|-----|-------------|
| 13/04/2026 | B/. 300 | Juan | PP-001A — Verificada |
| 14/04/2026 | B/. 500 | Juan | PP-002A — Pendiente |
| 15/04/2026 | B/. 400 | Juan | Sin comprobante [Subir] |

### 7. Historial Comprobante Column Logic

The comprobante column in historial de monto behaves differently by row type:

**Increases (linked to apertura solicitud):**
- While solicitud is pending/approved: show "Pendiente" text
- After solicitud reaches verificada (transferida): show download button for the transfer comprobante. The download uses the existing solicitud comprobante download endpoint (`GET /solicitudes-pago/:id/comprobante-adjuntos`) via the solicitud ID stored on the historial row.

**Decreases (manual comprobante):**
- If comprobante was uploaded: show download button
- If no comprobante: show "Sin comprobante" with an upload button

**Initial row:**
- Same as increases — shows the apertura solicitud status/download

### 8. Cierre Entry in Reembolsos Section

When the caja is closed, a **"Cierre"** entry appears as the last item in the reembolsos dropdown list in CajaMenudaDetail. It has a "Cierre" badge instead of a solicitud number.

The cierre entry shows:
- The gastos that were NOT reimbursed (left unlinked at closure time)
- The comprobante de cierre (auto-generated or manually uploaded)

The reembolsos section becomes a complete timeline: Reembolso 1, Reembolso 2, ..., Cierre.

## What Stays The Same

- Apertura solicitud creation on caja creation — unchanged
- Apertura solicitud creation on monto increase — unchanged
- Auto-PDF generation for zero-balance cierre — unchanged (implemented in #43)
- Regular and reembolso solicitud flows — unchanged
- Gasto registration — unchanged

## Constraints

- All existing CLAUDE.md rules apply
- Database value stays `transferida` — display-only rename to "Verificada"
- No new migrations needed (all changes are logic/UI)
- Parameterized queries only
- Call registrarAudit() on all create/edit/close operations
- Use AlertDialog for destructive actions (delete reembolso)
- Use shadcn DropdownMenu for the gear dropdown

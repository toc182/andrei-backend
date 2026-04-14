# Caja Menuda Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix UI/UX issues from testing, rework cierre logic, replace single edit modal with gear dropdown + 4 focused modals, and simplify the historial de monto table.

**Architecture:** Quick fixes first (badge rename, alignment, bug fix), then backend cierre logic rework, then the major frontend refactor (gear dropdown + modals), then historial changes and cierre in reembolsos.

**Tech Stack:** Express + TypeScript + PostgreSQL (backend), React 19 + TypeScript + Vite + shadcn/ui (frontend)

**Spec:** `andrei-backend/docs/superpowers/specs/2026-04-14-caja-menuda-refinements-design.md`

**Issue:** github.com/toc182/andrei-backend/issues/45

---

## File Structure

### Backend (andrei-backend/)

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/routes/solicitudesPago.ts:1270-1305` | Fix comprobante loading to include `transferida` estado |
| Modify | `src/routes/cajasMenudas.ts` | Cierre validation rework + `tiene_reembolso_pendiente` flag in GET endpoints |

### Frontend (andrei-frontend/)

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/pages/solicitudes/components/EstadoBadge.tsx` | Rename transferida → Verificada, blue color |
| Modify | `src/pages/solicitudes/types.ts` | ESTADO_OPTIONS label rename |
| Modify | `src/pages/solicitudes/dialogs/detail/SolicitudPaymentStatusCards.tsx` | Update labels for verificada |
| Modify | `src/pages/solicitudes/dialogs/RegistrarPagoDialog.tsx` | Update button text for verificada |
| Modify | `src/pages/CajaMenudaDetail.tsx` | Fix alert alignment, simplify historial table, add cierre to reembolsos, update badge labels |
| Modify | `src/pages/CajasMenudasPage.tsx` | Replace pencil/edit modal with gear dropdown + 4 modals |
| Modify | `src/types/api.ts` | Add `tiene_reembolso_pendiente` to CajaMenuda type |

---

## Task 1: Rename "Transferida" → "Verificada" (Blue Badge)

**Files:**
- Modify: `andrei-frontend/src/pages/solicitudes/components/EstadoBadge.tsx`
- Modify: `andrei-frontend/src/pages/solicitudes/types.ts`
- Modify: `andrei-frontend/src/pages/solicitudes/dialogs/detail/SolicitudPaymentStatusCards.tsx`
- Modify: `andrei-frontend/src/pages/CajaMenudaDetail.tsx`

- [ ] **Step 1: Update EstadoBadge.tsx**

In `EstadoBadge.tsx`, line 33, change the label and icon:
```typescript
  transferida: { variant: 'default', label: 'Verificada', icon: Check },
```

Line 42, change the color from teal to blue (matching `facturada`):
```typescript
  transferida: ' bg-blue-600 text-white',
```

Remove the `ArrowRightLeft` import from lucide-react (line 16) since it's no longer used. `Check` is already imported (line 9).

- [ ] **Step 2: Update ESTADO_OPTIONS in types.ts**

In `src/pages/solicitudes/types.ts`, find the transferida entry in `ESTADO_OPTIONS` and change the label:
```typescript
  { value: 'transferida', label: 'Verificada' },
```

- [ ] **Step 3: Update SolicitudPaymentStatusCards.tsx**

Find the card title that checks `solicitud.tipo === 'apertura'` and update the label:
```tsx
<h4 className="font-medium text-blue-900">
  {solicitud.tipo === 'apertura' ? 'Comprobante de Transferencia' : 'Comprobante de Pago'}
</h4>
```
This stays unchanged — "Comprobante de Transferencia" is still correct for the card title.

Find the date label and keep as-is:
```tsx
{solicitud.tipo === 'apertura' ? 'Fecha de transferencia' : 'Fecha de pago'}
```
No changes needed here.

- [ ] **Step 4: Update CajaMenudaDetail.tsx historial badges**

In the historial de monto table (around line 863), change the teal badge styling and label for `transferida`. Replace:
```tsx
h.solicitud_estado === 'transferida'
  ? 'bg-teal-50 text-teal-700 border-teal-300'
  : 'bg-yellow-50 text-amber-700 border-amber-300'
```
with:
```tsx
h.solicitud_estado === 'transferida'
  ? 'bg-blue-50 text-blue-700 border-blue-300'
  : 'bg-yellow-50 text-amber-700 border-amber-300'
```

And change the label text (line 868):
```tsx
{h.solicitud_numero} — {h.solicitud_estado === 'transferida' ? 'Verificada' : 'Pendiente'}
```

- [ ] **Step 5: Update CajasMenudasPage.tsx alert messages**

In the `ComprobanteAlertIcon` component, find the message that references "pendiente de transferencia" and keep it as-is — the user-facing alert says "pendiente de transferencia" which describes the action, not the estado. No change needed.

- [ ] **Step 6: Lint check**

Run: `cd andrei-frontend && npm run lint`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
cd andrei-frontend
git add src/pages/solicitudes/components/EstadoBadge.tsx src/pages/solicitudes/types.ts src/pages/CajaMenudaDetail.tsx
git commit -m "fix: rename Transferida badge to Verificada with blue color"
```

---

## Task 2: Fix Alert Alignment in CajaMenudaDetail

**Files:**
- Modify: `andrei-frontend/src/pages/CajaMenudaDetail.tsx:713-721`

- [ ] **Step 1: Fix the apertura alert alignment**

The alert at line 716-721 uses `<Alert variant="destructive">` with an `<AlertCircle>` icon and `<AlertDescription>`. The icon and text are misaligned vertically.

Replace lines 716-721:
```tsx
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Transferencia de apertura pendiente: La solicitud de apertura ({caja.solicitud_apertura_numero}) aún no tiene transferencia registrada.
            </AlertDescription>
          </Alert>
```
with:
```tsx
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Transferencia de apertura pendiente</AlertTitle>
            <AlertDescription>
              La solicitud de apertura ({caja.solicitud_apertura_numero}) aún no tiene transferencia registrada.
            </AlertDescription>
          </Alert>
```

Using `AlertTitle` + `AlertDescription` instead of just `AlertDescription` fixes the alignment because the shadcn Alert component is designed with both elements working together for proper vertical spacing.

Make sure `AlertTitle` is imported from `@/components/ui/alert` (it may already be imported).

- [ ] **Step 2: Lint check**

Run: `cd andrei-frontend && npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd andrei-frontend
git add src/pages/CajaMenudaDetail.tsx
git commit -m "fix: alert alignment in CajaMenudaDetail apertura banner"
```

---

## Task 3: Fix Comprobante Visibility Bug (Backend)

**Files:**
- Modify: `andrei-backend/src/routes/solicitudesPago.ts:1270-1274`

- [ ] **Step 1: Add transferida to comprobante loading condition**

In the GET /:id handler (around line 1270), the comprobante data only loads for `pagada` or `facturada`. Add `transferida`. Replace:
```typescript
      if (
        solicitud.rows[0].estado === 'pagada' ||
        solicitud.rows[0].estado === 'facturada'
      ) {
```
with:
```typescript
      if (
        solicitud.rows[0].estado === 'pagada' ||
        solicitud.rows[0].estado === 'facturada' ||
        solicitud.rows[0].estado === 'transferida'
      ) {
```

- [ ] **Step 2: Also check the reembolsada condition**

Search the same GET /:id handler for similar estado checks that might exclude `transferida` from loading related data (like `reembolso` data). The `reembolso` section (around line 1308+) only loads for `facturada` — that's correct, apertura solicitudes don't have facturas.

No other changes needed.

- [ ] **Step 3: Build check**

Run: `cd andrei-backend && npm run build`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
cd andrei-backend
git add src/routes/solicitudesPago.ts
git commit -m "fix: load comprobante data for transferida estado in solicitud detail"
```

---

## Task 4: Backend — Cierre Logic Rework + tiene_reembolso_pendiente Flag

**Files:**
- Modify: `andrei-backend/src/routes/cajasMenudas.ts`

- [ ] **Step 1: Update cierre validation in PUT /:id handler**

Find the cierre validation block (around line 511-530). Replace the current check:
```typescript
      if (estado === 'cerrada') {
        const pendingGastos = await query<{ count: string }>(
          `SELECT COUNT(*)::text as count FROM cajas_menudas_gastos g
           WHERE g.caja_menuda_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM solicitudes_pago sp
               WHERE sp.id = g.solicitud_reembolso_id
                 AND sp.estado = 'reembolsada'
             )`,
          [id],
        );
        if (Number(pendingGastos.rows[0].count) > 0) {
          res.status(400).json({
            success: false,
            error:
              'No se puede cerrar la caja menuda con gastos pendientes de reembolso',
          });
          return;
        }
      }
```

with:
```typescript
      if (estado === 'cerrada') {
        // Block closing if there are non-reembolsada reembolso solicitudes
        const pendingReembolsos = await query<{ count: string }>(
          `SELECT COUNT(*)::text as count
           FROM solicitudes_pago sp
           WHERE sp.id IN (
             SELECT DISTINCT g.solicitud_reembolso_id
             FROM cajas_menudas_gastos g
             WHERE g.caja_menuda_id = $1
               AND g.solicitud_reembolso_id IS NOT NULL
           )
           AND sp.estado != 'reembolsada'`,
          [id],
        );
        if (Number(pendingReembolsos.rows[0].count) > 0) {
          res.status(400).json({
            success: false,
            error:
              'No se puede cerrar la caja con una solicitud de reembolso pendiente. Elimine la solicitud de reembolso primero.',
          });
          return;
        }
      }
```

This allows closing with unlinked gastos (expenses without a reembolso solicitud). It only blocks when there's an in-progress reembolso solicitud.

- [ ] **Step 2: Add tiene_reembolso_pendiente to GET / (list all)**

In the GET / query (around line 110), add after the `historial_pendiente_transferencia` EXISTS subquery:
```sql
              EXISTS (
                SELECT 1 FROM solicitudes_pago sp
                WHERE sp.id IN (
                  SELECT DISTINCT g.solicitud_reembolso_id
                  FROM cajas_menudas_gastos g
                  WHERE g.caja_menuda_id = cm.id
                    AND g.solicitud_reembolso_id IS NOT NULL
                )
                AND sp.estado != 'reembolsada'
              ) AS tiene_reembolso_pendiente,
```

- [ ] **Step 3: Add tiene_reembolso_pendiente to GET /proyecto/:proyectoId**

Same change as Step 2 in the project-specific query.

- [ ] **Step 4: Add tiene_reembolso_pendiente to GET /:id (detail)**

Same change as Step 2 in the detail query.

- [ ] **Step 5: Add to CajaMenudaRow interface**

Add to the `CajaMenudaRow` interface at the top of the file:
```typescript
  tiene_reembolso_pendiente?: boolean;
```

- [ ] **Step 6: Build check**

Run: `cd andrei-backend && npm run build`
Expected: Compiles with no errors.

- [ ] **Step 7: Commit**

```bash
cd andrei-backend
git add src/routes/cajasMenudas.ts
git commit -m "feat: cierre allows unlinked gastos, blocks only on pending reembolso solicitudes"
```

---

## Task 5: Frontend Type — Add tiene_reembolso_pendiente

**Files:**
- Modify: `andrei-frontend/src/types/api.ts`

- [ ] **Step 1: Update CajaMenuda interface**

Add to the `CajaMenuda` interface:
```typescript
  tiene_reembolso_pendiente?: boolean;
```

- [ ] **Step 2: Commit**

```bash
cd andrei-frontend
git add src/types/api.ts
git commit -m "feat: add tiene_reembolso_pendiente to CajaMenuda type"
```

---

## Task 6: Replace Edit Modal with Gear Dropdown + 4 Modals

**Files:**
- Modify: `andrei-frontend/src/pages/CajasMenudasPage.tsx`

This is the largest task. The current file has a single edit modal with all fields. We replace it with a gear icon dropdown and 4 focused modals.

- [ ] **Step 1: Read the full file to understand current structure**

Read `src/pages/CajasMenudasPage.tsx` completely. Note:
- The form schema (lines ~30-44): `proyecto_id, responsable_id, nombre, monto_asignado, estado`
- State variables (lines ~122-134): `showFormModal, editingCaja, comprobanteFile, montoComprobanteFile`, refs
- `handleNew()` (line ~194): Opens create modal
- `handleEdit()` (line ~208): Opens edit modal
- `handleSubmit()` (line ~223): Handles create + edit + monto change
- The Dialog component (lines ~414-624): Single modal with all fields
- Pencil button in desktop table (line ~394-403)
- Mobile cards don't have an edit button (they just navigate to detail)

- [ ] **Step 2: Add new imports**

Add these imports at the top of the file:
```typescript
import { Settings, Plus, Minus, Lock } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
```

Note: Check if `Tooltip` components exist in `src/components/ui/`. If not, the disabled state tooltip can use a native `title` attribute on the menu item instead.

Remove `Pencil` from the lucide-react import since it's no longer used.

- [ ] **Step 3: Replace state variables**

Remove these state variables:
- `showFormModal`
- `editingCaja`
- `comprobanteFile`, `setComprobanteFile`
- `montoComprobanteFile`, `setMontoComprobanteFile`
- `comprobanteRef`, `montoComprobanteRef`
- The form schema definition (zod schema)
- The `useForm` call
- `watchEstado`

Add new state variables:
```typescript
// Modal states
const [editModalCaja, setEditModalCaja] = useState<CajaMenuda | null>(null);
const [subirMontoModalCaja, setSubirMontoModalCaja] = useState<CajaMenuda | null>(null);
const [bajarMontoModalCaja, setBajarMontoModalCaja] = useState<CajaMenuda | null>(null);
const [cerrarModalCaja, setCerrarModalCaja] = useState<CajaMenuda | null>(null);

// Edit modal form
const [editNombre, setEditNombre] = useState('');
const [editResponsableId, setEditResponsableId] = useState('');

// Monto modal form
const [nuevoMonto, setNuevoMonto] = useState('');

// Cerrar modal form
const [comprobanteFile, setComprobanteFile] = useState<File | null>(null);
const comprobanteRef = useRef<HTMLInputElement>(null);

const [submitting, setSubmitting] = useState(false);
const [error, setError] = useState('');
```

- [ ] **Step 4: Replace handlers**

Remove `handleNew`, `handleEdit`, `handleSubmit`. Add:

```typescript
const handleEditSubmit = async () => {
  if (!editModalCaja) return;
  try {
    setSubmitting(true);
    setError('');
    const formData = new FormData();
    formData.append('nombre', editNombre);
    formData.append('responsable_id', editResponsableId);
    await api.put(`/cajas-menudas/${editModalCaja.id}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    setEditModalCaja(null);
    loadCajas();
  } catch (err) {
    const apiErr = err as { response?: { data?: { error?: string } } };
    setError(apiErr.response?.data?.error || 'Error al actualizar');
  } finally {
    setSubmitting(false);
  }
};

const handleSubirMontoSubmit = async () => {
  if (!subirMontoModalCaja) return;
  const monto = Number(nuevoMonto);
  if (isNaN(monto) || monto <= Number(subirMontoModalCaja.monto_asignado)) {
    setError('El monto debe ser mayor al actual');
    return;
  }
  try {
    setSubmitting(true);
    setError('');
    await api.put(`/cajas-menudas/${subirMontoModalCaja.id}/monto`, {
      monto_asignado: monto,
    });
    setSubirMontoModalCaja(null);
    loadCajas();
  } catch (err) {
    const apiErr = err as { response?: { data?: { error?: string } } };
    setError(apiErr.response?.data?.error || 'Error al subir monto');
  } finally {
    setSubmitting(false);
  }
};

const handleBajarMontoSubmit = async () => {
  if (!bajarMontoModalCaja) return;
  const monto = Number(nuevoMonto);
  if (isNaN(monto) || monto >= Number(bajarMontoModalCaja.monto_asignado) || monto <= 0) {
    setError('El monto debe ser menor al actual y mayor que cero');
    return;
  }
  try {
    setSubmitting(true);
    setError('');
    const formData = new FormData();
    formData.append('monto_asignado', String(monto));
    if (comprobanteFile) formData.append('comprobante', comprobanteFile);
    await api.put(`/cajas-menudas/${bajarMontoModalCaja.id}/monto`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    setBajarMontoModalCaja(null);
    loadCajas();
  } catch (err) {
    const apiErr = err as { response?: { data?: { error?: string } } };
    setError(apiErr.response?.data?.error || 'Error al bajar monto');
  } finally {
    setSubmitting(false);
  }
};

const handleCerrarSubmit = async () => {
  if (!cerrarModalCaja) return;
  const saldo = Number(cerrarModalCaja.saldo);
  if (saldo > 0 && !comprobanteFile) {
    setError('Se requiere un comprobante de cierre para cajas con saldo pendiente');
    return;
  }
  try {
    setSubmitting(true);
    setError('');
    const formData = new FormData();
    formData.append('estado', 'cerrada');
    if (comprobanteFile) formData.append('comprobante_cierre', comprobanteFile);
    await api.put(`/cajas-menudas/${cerrarModalCaja.id}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    setCerrarModalCaja(null);
    loadCajas();
  } catch (err) {
    const apiErr = err as { response?: { data?: { error?: string } } };
    setError(apiErr.response?.data?.error || 'Error al cerrar caja');
  } finally {
    setSubmitting(false);
  }
};
```

- [ ] **Step 5: Replace pencil button with gear dropdown in desktop table**

Replace the pencil button (lines 393-404) with:

```tsx
<TableCell>
  {caja.estado === 'abierta' && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => e.stopPropagation()}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => {
          setEditNombre(caja.nombre);
          setEditResponsableId(String(caja.responsable_id));
          setError('');
          setEditModalCaja(caja);
        }}>
          <Pencil className="mr-2 h-4 w-4" />
          Editar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => {
          setNuevoMonto('');
          setError('');
          setSubirMontoModalCaja(caja);
        }}>
          <Plus className="mr-2 h-4 w-4 text-green-600" />
          <span className="text-green-600">Subir monto</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => {
          setNuevoMonto('');
          setComprobanteFile(null);
          setError('');
          setBajarMontoModalCaja(caja);
        }}>
          <Minus className="mr-2 h-4 w-4 text-red-600" />
          <span className="text-red-600">Bajar monto</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {caja.tiene_reembolso_pendiente ? (
          <DropdownMenuItem disabled title="Tiene solicitud de reembolso pendiente">
            <Lock className="mr-2 h-4 w-4" />
            Cerrar caja
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => {
            setComprobanteFile(null);
            setError('');
            setCerrarModalCaja(caja);
          }}>
            <Lock className="mr-2 h-4 w-4" />
            Cerrar caja
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )}
</TableCell>
```

Note: Keep `Pencil` in the imports after all — it's used inside the dropdown menu item.

- [ ] **Step 6: Add gear dropdown to mobile cards**

In the mobile card section (around line 337), add the gear dropdown. Place it in the top-right area of the card (alongside the estado badge):

```tsx
<div className="flex items-center gap-2">
  {estadoBadge(caja.estado)}
  {caja.estado === 'abierta' && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => {
          setEditNombre(caja.nombre);
          setEditResponsableId(String(caja.responsable_id));
          setError('');
          setEditModalCaja(caja);
        }}>
          <Pencil className="mr-2 h-4 w-4" />
          Editar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => {
          setNuevoMonto('');
          setError('');
          setSubirMontoModalCaja(caja);
        }}>
          <Plus className="mr-2 h-4 w-4 text-green-600" />
          <span className="text-green-600">Subir monto</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => {
          setNuevoMonto('');
          setComprobanteFile(null);
          setError('');
          setBajarMontoModalCaja(caja);
        }}>
          <Minus className="mr-2 h-4 w-4 text-red-600" />
          <span className="text-red-600">Bajar monto</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {caja.tiene_reembolso_pendiente ? (
          <DropdownMenuItem disabled title="Tiene solicitud de reembolso pendiente">
            <Lock className="mr-2 h-4 w-4" />
            Cerrar caja
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => {
            setComprobanteFile(null);
            setError('');
            setCerrarModalCaja(caja);
          }}>
            <Lock className="mr-2 h-4 w-4" />
            Cerrar caja
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )}
</div>
```

- [ ] **Step 7: Replace the single Dialog with 4 Dialogs**

Remove the entire existing Dialog component (the large block starting around line 414 through to the closing `</Dialog>`). Replace with 4 focused dialogs:

**Edit Dialog:**
```tsx
{/* Edit Modal */}
<Dialog open={!!editModalCaja} onOpenChange={(open) => !open && setEditModalCaja(null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Editar Caja Menuda</DialogTitle>
    </DialogHeader>
    <div className="space-y-4 py-4">
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="space-y-2">
        <label className="text-sm font-medium">Nombre *</label>
        <Input
          value={editNombre}
          onChange={(e) => setEditNombre(e.target.value)}
          placeholder="Nombre de la caja"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Responsable *</label>
        <Select value={editResponsableId} onValueChange={setEditResponsableId}>
          <SelectTrigger>
            <SelectValue placeholder="Seleccionar responsable" />
          </SelectTrigger>
          <SelectContent>
            {usuarios.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>{u.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setEditModalCaja(null)} disabled={submitting}>
        Cancelar
      </Button>
      <Button onClick={handleEditSubmit} disabled={submitting || !editNombre.trim() || !editResponsableId}>
        {submitting ? 'Guardando...' : 'Guardar'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Subir Monto Dialog:**
```tsx
{/* Subir Monto Modal */}
<Dialog open={!!subirMontoModalCaja} onOpenChange={(open) => !open && setSubirMontoModalCaja(null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Subir Monto — {subirMontoModalCaja?.nombre}</DialogTitle>
      <DialogDescription>
        Monto actual: {formatMonto(subirMontoModalCaja?.monto_asignado)}
      </DialogDescription>
    </DialogHeader>
    <div className="space-y-4 py-4">
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="space-y-2">
        <label className="text-sm font-medium">Nuevo monto *</label>
        <Input
          type="number"
          step="0.01"
          min={Number(subirMontoModalCaja?.monto_asignado || 0) + 0.01}
          value={nuevoMonto}
          onChange={(e) => setNuevoMonto(e.target.value)}
          placeholder="0.00"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Se creará una solicitud de apertura automática por la diferencia.
      </p>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setSubirMontoModalCaja(null)} disabled={submitting}>
        Cancelar
      </Button>
      <Button onClick={handleSubirMontoSubmit} disabled={submitting || !nuevoMonto}>
        {submitting ? 'Guardando...' : 'Confirmar'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Bajar Monto Dialog:**
```tsx
{/* Bajar Monto Modal */}
<Dialog open={!!bajarMontoModalCaja} onOpenChange={(open) => { if (!open) { setBajarMontoModalCaja(null); setComprobanteFile(null); } }}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Bajar Monto — {bajarMontoModalCaja?.nombre}</DialogTitle>
      <DialogDescription>
        Monto actual: {formatMonto(bajarMontoModalCaja?.monto_asignado)}
      </DialogDescription>
    </DialogHeader>
    <div className="space-y-4 py-4">
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="space-y-2">
        <label className="text-sm font-medium">Nuevo monto *</label>
        <Input
          type="number"
          step="0.01"
          min="0.01"
          max={Number(bajarMontoModalCaja?.monto_asignado || 0) - 0.01}
          value={nuevoMonto}
          onChange={(e) => setNuevoMonto(e.target.value)}
          placeholder="0.00"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Comprobante del cambio de monto</label>
        <div className="flex items-center gap-2">
          <input
            ref={comprobanteRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="hidden"
            onChange={(e) => setComprobanteFile(e.target.files?.[0] || null)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => comprobanteRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            {comprobanteFile ? comprobanteFile.name : 'Seleccionar archivo'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Comprobante de la devolución de fondos (opcional).
        </p>
      </div>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => { setBajarMontoModalCaja(null); setComprobanteFile(null); }} disabled={submitting}>
        Cancelar
      </Button>
      <Button onClick={handleBajarMontoSubmit} disabled={submitting || !nuevoMonto}>
        {submitting ? 'Guardando...' : 'Confirmar'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Cerrar Caja Dialog:**
```tsx
{/* Cerrar Caja Modal */}
<Dialog open={!!cerrarModalCaja} onOpenChange={(open) => { if (!open) { setCerrarModalCaja(null); setComprobanteFile(null); } }}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Cerrar Caja Menuda — {cerrarModalCaja?.nombre}</DialogTitle>
      <DialogDescription>
        Saldo actual: {formatMonto(cerrarModalCaja?.saldo)}
      </DialogDescription>
    </DialogHeader>
    <div className="space-y-4 py-4">
      {error && <p className="text-sm text-red-500">{error}</p>}
      {Number(cerrarModalCaja?.saldo) === 0 ? (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
          El saldo es cero — se generará automáticamente una constancia de cierre.
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-sm font-medium">Comprobante de cierre *</label>
          <div className="flex items-center gap-2">
            <input
              ref={comprobanteRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => setComprobanteFile(e.target.files?.[0] || null)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => comprobanteRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              {comprobanteFile ? comprobanteFile.name : 'Seleccionar archivo'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Documento firmado de devolución del saldo.
          </p>
        </div>
      )}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => { setCerrarModalCaja(null); setComprobanteFile(null); }} disabled={submitting}>
        Cancelar
      </Button>
      <Button variant="destructive" onClick={handleCerrarSubmit} disabled={submitting}>
        {submitting ? 'Cerrando...' : 'Cerrar Caja'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 8: Remove the "Crear Caja Menuda" form from this page**

The creation form (with proyecto_id, responsable_id, nombre, monto_asignado) stays as-is — it's the "Nueva Caja" button at the top. But it should now be a standalone simple dialog without the edit-related fields (estado, comprobante sections). 

Keep the existing create flow: `handleNew()` opens a create dialog with proyecto_id, responsable_id, nombre, monto_asignado. The `handleSubmit` for creation sends a JSON POST to `/cajas-menudas`. This is unchanged from yesterday's implementation.

Adapt the create dialog to use its own state separate from the 4 action modals. Keep the existing `showFormModal` state for the create dialog only.

- [ ] **Step 9: Clean up unused imports and variables**

Remove any imports, state variables, refs, or functions that are no longer used after the refactor. Run lint to catch unused vars.

- [ ] **Step 10: Lint check**

Run: `cd andrei-frontend && npm run lint`
Expected: 0 errors.

- [ ] **Step 11: Commit**

```bash
cd andrei-frontend
git add src/pages/CajasMenudasPage.tsx
git commit -m "feat: replace edit modal with gear dropdown + 4 focused modals"
```

---

## Task 7: Simplify Historial de Monto Table

**Files:**
- Modify: `andrei-frontend/src/pages/CajaMenudaDetail.tsx:836-910`

- [ ] **Step 1: Add synthetic initial row and simplify columns**

Replace the historial section (lines 836-910) with:

```tsx
      {/* Historial de monto asignado */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Historial de monto asignado</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Cambiado por</TableHead>
                <TableHead className="text-right">Monto</TableHead>
                <TableHead>Comprobante</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Synthetic initial row */}
              <TableRow>
                <TableCell>{formatDate(caja.created_at)}</TableCell>
                <TableCell>{caja.created_by_nombre || '—'}</TableCell>
                <TableCell className="text-right font-medium">
                  {(() => {
                    // Calculate original monto: walk backwards through historial
                    const sorted = [...(caja.historial_montos || [])].sort(
                      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                    );
                    const originalMonto = sorted.length > 0 ? sorted[0].monto_anterior : caja.monto_asignado;
                    return formatMonto(originalMonto);
                  })()}
                </TableCell>
                <TableCell>
                  {caja.solicitud_apertura_id ? (
                    caja.solicitud_apertura_estado === 'transferida' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDownloadApertura()}
                      >
                        <Download className="mr-2 h-3 w-3" />
                        Descargar
                      </Button>
                    ) : (
                      <Badge variant="outline" className="bg-yellow-50 text-amber-700 border-amber-300">
                        {caja.solicitud_apertura_numero} — Pendiente
                      </Badge>
                    )
                  ) : caja.comprobante_apertura_r2_key ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownloadApertura()}
                    >
                      <Download className="mr-2 h-3 w-3" />
                      Descargar
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>

              {/* Historial rows */}
              {caja.historial_montos?.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{formatDate(h.created_at)}</TableCell>
                  <TableCell>{h.cambiado_por_nombre}</TableCell>
                  <TableCell className="text-right font-medium">{formatMonto(h.monto_nuevo)}</TableCell>
                  <TableCell>
                    {h.solicitud_id ? (
                      h.solicitud_estado === 'transferida' ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownloadSolicitudComprobante(h.solicitud_id!)}
                        >
                          <Download className="mr-2 h-3 w-3" />
                          Descargar
                        </Button>
                      ) : (
                        <Badge variant="outline" className="bg-yellow-50 text-amber-700 border-amber-300">
                          {h.solicitud_numero} — Pendiente
                        </Badge>
                      )
                    ) : h.comprobante_r2_key ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDownloadHistorialComprobante(h.id)}
                      >
                        <Download className="mr-2 h-3 w-3" />
                        Descargar
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-sm text-red-500">
                          <AlertCircle className="h-3 w-3" />
                          Sin comprobante
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => triggerHistorialUpload(h.id)}
                          disabled={uploadingHistorialId === h.id}
                        >
                          {uploadingHistorialId === h.id ? (
                            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                          ) : (
                            <Upload className="mr-2 h-3 w-3" />
                          )}
                          Subir
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
```

Note: The section now always renders (no condition on `historial_montos.length > 0`) because the synthetic initial row always exists.

- [ ] **Step 2: Add handleDownloadSolicitudComprobante handler**

Add a new handler to download the comprobante from a solicitud's adjuntos. The codebase uses signed URLs via `GET /solicitudes-pago/:id/adjuntos/urls`. For simplicity, fetch the URLs and open the first comprobante-type adjunto:

```typescript
const handleDownloadSolicitudComprobante = async (solicitudId: number) => {
  try {
    const response = await api.get(`/solicitudes-pago/${solicitudId}/adjuntos/urls`);
    if (response.data.success && response.data.adjuntos?.length > 0) {
      // Find the first comprobante adjunto (tipo_adjunto = 'comprobante')
      const comprobante = response.data.adjuntos.find(
        (a: { tipo_adjunto?: string }) => a.tipo_adjunto === 'comprobante'
      ) || response.data.adjuntos[0];
      if (comprobante?.url) {
        window.open(comprobante.url, '_blank');
      }
    }
  } catch (err) {
    console.error('Error downloading solicitud comprobante:', err);
  }
};
```

- [ ] **Step 3: Check that created_by_nombre is returned by the backend**

The initial row uses `caja.created_by_nombre`. Check if the GET /:id endpoint returns this. If not, add it to the backend query (JOIN users for created_by) and to the frontend type.

- [ ] **Step 4: Lint check**

Run: `cd andrei-frontend && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
cd andrei-frontend
git add src/pages/CajaMenudaDetail.tsx
git commit -m "feat: simplify historial table — single Monto column, initial row, download buttons"
```

---

## Task 8: Cierre Entry in Reembolsos Section

**Files:**
- Modify: `andrei-frontend/src/pages/CajaMenudaDetail.tsx:912-945`

- [ ] **Step 1: Add cierre entry to reembolsos dropdown**

In the gastos section dropdown (around line 917-931), add a "Cierre" entry after the reembolsos loop. This only appears when the caja is closed:

After the `caja.reembolsos?.map(...)` block (line 929), add:
```tsx
{caja.estado === 'cerrada' && (
  <SelectItem value="cierre">
    Cierre — Gastos finales
  </SelectItem>
)}
```

- [ ] **Step 2: Handle cierre filter in gastos loading**

When `gastosFilter === 'cierre'`, show the gastos that were NOT linked to any reembolso solicitud (unlinked gastos at closure time). These are gastos where `solicitud_reembolso_id IS NULL`.

Find where gastos are loaded based on the filter. The current logic loads:
- `"pending"` → gastos where `solicitud_reembolso_id IS NULL`
- A reembolso ID → gastos where `solicitud_reembolso_id = <id>`

For `"cierre"`, use the same query as `"pending"` (gastos without a reembolso link). The backend already returns this correctly. So `"cierre"` uses the same filter as `"pending"`.

Update the gastos loading logic:
```typescript
// When filter is "cierre", load the same as "pending" — unlinked gastos
const filterParam = gastosFilter === 'cierre' ? 'pending' : gastosFilter;
```

- [ ] **Step 3: Show cierre comprobante alongside gastos**

When `gastosFilter === 'cierre'`, show the comprobante de cierre download button above the gastos table:

```tsx
{gastosFilter === 'cierre' && caja.comprobante_cierre_r2_key && (
  <div className="flex items-center gap-2 text-sm text-muted-foreground">
    <FileCheck className="h-4 w-4" />
    <span>Comprobante de cierre:</span>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleDownloadCierre}
    >
      <Download className="mr-2 h-3 w-3" />
      Descargar
    </Button>
  </div>
)}
```

Make sure `FileCheck` is imported from `lucide-react`.

- [ ] **Step 4: Set default filter to cierre for closed cajas**

When the caja is closed, the default `gastosFilter` should be `"cierre"` (not `"pending"`). Update the initial state or the effect that sets the filter:

```typescript
// When caja loads and is closed, default to cierre view
useEffect(() => {
  if (caja?.estado === 'cerrada') {
    setGastosFilter('cierre');
  }
}, [caja?.estado]);
```

- [ ] **Step 5: Lint check**

Run: `cd andrei-frontend && npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
cd andrei-frontend
git add src/pages/CajaMenudaDetail.tsx
git commit -m "feat: cierre entry in reembolsos dropdown with final gastos and comprobante"
```

---

## Task 9: Build Verification

- [ ] **Step 1: Backend build**

Run: `cd andrei-backend && npm run build`
Expected: Compiles with no errors.

- [ ] **Step 2: Frontend lint and build**

Run: `cd andrei-frontend && npm run lint && npm run build`
Expected: Both pass with no errors.

- [ ] **Step 3: Final commit if fixes needed**

If build/lint required fixes, commit them.

---

## Notes for Implementer

### Tooltip component
Check if `@/components/ui/tooltip` exists. If not, use the `title` HTML attribute on the disabled dropdown item instead of the Tooltip component. The shadcn tooltip may not be installed.

### created_by_nombre
The GET /:id endpoint may not return `created_by_nombre`. If it doesn't, you need to add a JOIN on users for `created_by` in the backend detail query and add the field to the frontend type. This is a small backend change.

### Solicitud comprobante download
The `handleDownloadSolicitudComprobante` handler uses `GET /solicitudes-pago/:id/adjuntos/urls` which returns signed URLs for all adjuntos. The handler opens the first comprobante-type adjunto URL in a new tab.

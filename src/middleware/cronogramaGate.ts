// Single-user gate for the Cronograma feature (v1).
//
// WHY EMAIL, NOT A PERMISSION: checkPermission/checkProjectAccess let admin & co-admin
// BYPASS unconditionally (see auth.ts), so a permission key cannot hide this feature from
// other admins. v1 must be visible to EXACTLY ONE user, so we gate by email here.
//
// THE ONE-LINE FLIP to open it up later (and the matching change in the frontend
// src/lib/cronogramaAccess.ts):
//   return !!user?.permissions?.cronogramas_ver || user?.rol === 'admin' || user?.rol === 'co-admin';
// then swap betaFeatureSingleUser -> checkPermission('cronogramas_ver') in routes/cronogramas.ts
// and register 'cronogramas_ver' in VALID_PERMISSIONS (auth.ts) + UserPermissions (types/auth.ts).
// The DB column already exists (migration 136).

import { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '../types/auth.js';

const ALLOWED_EMAILS = ['ivan@pinellaspanama.com'];

/** SINGLE SOURCE OF TRUTH for backend cronograma access. */
export function canUseCronogramas(user: AuthUser | undefined): boolean {
  return !!user && ALLOWED_EMAILS.includes(user.email);
}

export function betaFeatureSingleUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'No autenticado' });
    return;
  }
  if (!canUseCronogramas(req.user)) {
    res.status(403).json({ success: false, message: 'No tienes acceso a esta función' });
    return;
  }
  next();
}

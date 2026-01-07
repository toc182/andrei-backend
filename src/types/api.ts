import { ValidationError } from 'express-validator';

/**
 * Respuesta estándar de la API
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  errors?: ValidationError[];
}

/**
 * Respuesta paginada
 */
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    current_page: number;
    total_pages: number;
    total_records: number;
    per_page: number;
  };
}

/**
 * Parámetros de paginación en query string
 */
export interface PaginationParams {
  page?: string | number;
  limit?: string | number;
  offset?: number;
}

/**
 * Respuesta de error
 */
export interface ErrorResponse {
  success: false;
  message: string;
  error?: string;
  errors?: ValidationError[];
}

/**
 * Respuesta de éxito genérica
 */
export interface SuccessResponse<T = unknown> {
  success: true;
  message?: string;
  data?: T;
}

/**
 * QueryBuilder - Utility for building dynamic SQL WHERE clauses
 *
 * Simplifies the common pattern of building queries with optional filters.
 * Handles parameter counting and AND concatenation automatically.
 *
 * Usage:
 *   const qb = new QueryBuilder();
 *   qb.where('activo', true);
 *   qb.whereIf(estado, 'estado', estado);
 *   qb.whereILike(search, ['descripcion', 'marca', 'modelo']);
 *
 *   const result = await query(`SELECT * FROM equipos ${qb.toSQL()}`, qb.params);
 */

type ParamValue = string | number | boolean | null | undefined;

export class QueryBuilder {
  private conditions: string[] = [];
  private _params: ParamValue[] = [];
  private paramCounter = 1;

  /**
   * Add a simple equality condition
   */
  where(column: string, value: ParamValue): this {
    this.conditions.push(`${column} = $${this.paramCounter}`);
    this._params.push(value);
    this.paramCounter++;
    return this;
  }

  /**
   * Add condition only if value is truthy
   */
  whereIf(condition: unknown, column: string, value: ParamValue): this {
    if (condition) {
      this.where(column, value);
    }
    return this;
  }

  /**
   * Add equality condition only if value is not null/undefined
   */
  whereNotNull(column: string, value: ParamValue): this {
    if (value !== null && value !== undefined && value !== '') {
      this.where(column, value);
    }
    return this;
  }

  /**
   * Add ILIKE search across multiple columns (OR)
   */
  whereILike(value: string | undefined | null, columns: string[]): this {
    if (!value) return this;

    const likeConditions = columns.map(
      (col) => `${col} ILIKE $${this.paramCounter}`,
    );
    this.conditions.push(`(${likeConditions.join(' OR ')})`);
    this._params.push(`%${value}%`);
    this.paramCounter++;
    return this;
  }

  /**
   * Add IN clause
   */
  whereIn(column: string, values: ParamValue[]): this {
    if (!values || values.length === 0) return this;

    const placeholders = values
      .map((_, i) => `$${this.paramCounter + i}`)
      .join(', ');
    this.conditions.push(`${column} IN (${placeholders})`);
    this._params.push(...values);
    this.paramCounter += values.length;
    return this;
  }

  /**
   * Add IN clause only if values array is not empty
   */
  whereInIf(condition: unknown, column: string, values: ParamValue[]): this {
    if (condition && values && values.length > 0) {
      this.whereIn(column, values);
    }
    return this;
  }

  /**
   * Add a raw condition with automatic parameter handling
   * Use $NEXT for the next parameter placeholder
   */
  whereRaw(condition: string, ...values: ParamValue[]): this {
    let processedCondition = condition;
    for (const value of values) {
      processedCondition = processedCondition.replace(
        '$NEXT',
        `$${this.paramCounter}`,
      );
      this._params.push(value);
      this.paramCounter++;
    }
    this.conditions.push(processedCondition);
    return this;
  }

  /**
   * Add raw condition only if condition is truthy
   */
  whereRawIf(check: unknown, condition: string, ...values: ParamValue[]): this {
    if (check) {
      this.whereRaw(condition, ...values);
    }
    return this;
  }

  /**
   * Add comparison condition (>, <, >=, <=, !=)
   */
  whereCompare(
    column: string,
    operator: '>' | '<' | '>=' | '<=' | '!=' | '<>',
    value: ParamValue,
  ): this {
    this.conditions.push(`${column} ${operator} $${this.paramCounter}`);
    this._params.push(value);
    this.paramCounter++;
    return this;
  }

  /**
   * Add comparison only if value is truthy
   */
  whereCompareIf(
    condition: unknown,
    column: string,
    operator: '>' | '<' | '>=' | '<=' | '!=' | '<>',
    value: ParamValue,
  ): this {
    if (condition) {
      this.whereCompare(column, operator, value);
    }
    return this;
  }

  /**
   * Add IS NULL condition
   */
  whereNull(column: string): this {
    this.conditions.push(`${column} IS NULL`);
    return this;
  }

  /**
   * Add IS NOT NULL condition
   */
  whereNotNullColumn(column: string): this {
    this.conditions.push(`${column} IS NOT NULL`);
    return this;
  }

  /**
   * Add BETWEEN condition
   */
  whereBetween(column: string, min: ParamValue, max: ParamValue): this {
    this.conditions.push(
      `${column} BETWEEN $${this.paramCounter} AND $${this.paramCounter + 1}`,
    );
    this._params.push(min, max);
    this.paramCounter += 2;
    return this;
  }

  /**
   * Get the parameters array
   */
  get params(): ParamValue[] {
    return this._params;
  }

  /**
   * Get current parameter count (useful for additional manual parameters)
   */
  get nextParam(): number {
    return this.paramCounter;
  }

  /**
   * Check if any conditions have been added
   */
  get hasConditions(): boolean {
    return this.conditions.length > 0;
  }

  /**
   * Generate the WHERE clause SQL
   * Returns empty string if no conditions, otherwise "WHERE condition1 AND condition2..."
   */
  toSQL(): string {
    if (this.conditions.length === 0) {
      return '';
    }
    return `WHERE ${this.conditions.join(' AND ')}`;
  }

  /**
   * Generate WHERE clause starting with a base condition
   * Useful when you always have at least one condition (e.g., activo = true)
   */
  toSQLWithBase(baseCondition: string): string {
    if (this.conditions.length === 0) {
      return `WHERE ${baseCondition}`;
    }
    return `WHERE ${baseCondition} AND ${this.conditions.join(' AND ')}`;
  }

  /**
   * Reset the builder for reuse
   */
  reset(): this {
    this.conditions = [];
    this._params = [];
    this.paramCounter = 1;
    return this;
  }
}

export default QueryBuilder;

import { Request } from '@lib/http/Request.js'

export class LiteTable {
  protected query: any
  protected request: Request
  protected columnsList: any[] = []
  protected addedColumns: Record<string, (row: any, column?: any) => any> = {}
  protected editedColumns: Record<string, (row: any, rawValue: any, column?: any) => any> = {}
  protected multiEditedColumns: Record<string, (rawValue: any) => any> = {}
  protected filterCallbacks: Record<string, (query: any, keyword: string, column: any, type: 'global' | 'column') => void> = {}
  protected orderCallbacks: Record<string, (query: any, direction: 'asc' | 'desc', column: any) => void> = {}
  protected rawColumnsList: string[] = []
  protected withIndexColumn = false
  protected rowIdResolver: string | ((row: any) => string) | null = null
  protected defaultOrderColumn: string | null = null
  protected defaultOrderDirection: 'asc' | 'desc' = 'asc'
  protected escapeOutput = true
  protected exportHeaders: string[] | null = null

  constructor(query: any, request: Request) {
    this.query = query
    this.request = request
  }

  /**
   * Factory method to instantiate LiteTable.
   */
  static make(query: any, request: Request): LiteTable {
    return new LiteTable(query, request)
  }

  // -------------------------------------------------------------------------
  // Fluent configuration
  // -------------------------------------------------------------------------

  columns(columns: any[]): this {
    this.columnsList = this.normalizeColumns(columns)
    return this
  }

  addIndexColumn(): this {
    this.withIndexColumn = true
    return this
  }

  setRowId(resolver: string | ((row: any) => string)): this {
    this.rowIdResolver = resolver
    return this
  }

  defaultOrder(column: string, direction = 'asc'): this {
    this.defaultOrderColumn = column
    this.defaultOrderDirection = String(direction).toLowerCase() === 'desc' ? 'desc' : 'asc'
    return this
  }

  rawColumns(columns: string[]): this {
    this.rawColumnsList = Array.from(new Set(columns.map(String)))
    return this
  }

  addColumn(key: string, callback: (row: any, column?: any) => any): this {
    this.addedColumns[key] = callback
    return this
  }

  editColumn(key: string, callback: (row: any, rawValue: any, column?: any) => any): this {
    this.editedColumns[key] = callback
    return this
  }

  editColumns(columns: string[], callback: (rawValue: any) => any): this {
    for (const column of columns) {
      this.multiEditedColumns[column] = callback
    }
    return this
  }

  filterColumn(key: string, callback: (query: any, keyword: string, column: any, type: 'global' | 'column') => void): this {
    this.filterCallbacks[key] = callback
    return this
  }

  orderColumn(key: string, callback: (query: any, direction: 'asc' | 'desc', column: any) => void): this {
    this.orderCallbacks[key] = callback
    return this
  }

  setExportHeaders(headers: string[]): this {
    this.exportHeaders = headers
    return this
  }

  // -------------------------------------------------------------------------
  // Core rendering & processing
  // -------------------------------------------------------------------------

  async render(response?: any): Promise<any> {
    const columns = this.resolveColumns()

    const draw = Number(this.request.input('draw', 1))
    const start = Math.max(Number(this.request.input('start', 0)), 0)
    const length = Number(this.request.input('length', 10))

    const totalQuery = this.query.clone()
    const filteredQuery = this.query.clone()

    // 1. Get recordsTotal count
    const totalCountQuery = totalQuery.clone()
    if (typeof totalCountQuery.count === 'function') {
      totalCountQuery.count({ count: '*' })
    }
    const totalCountRes = await totalCountQuery
    const recordsTotal = Number(totalCountRes[0]?.count ?? 0)

    // 2. Apply search and sorting
    this.applyGlobalSearch(filteredQuery, columns)
    this.applyColumnSearch(filteredQuery, columns)
    this.applyOrdering(filteredQuery, columns)

    // 3. Get recordsFiltered count
    let recordsFiltered = recordsTotal
    const search = this.request.input<any>('search')
    const globalKeyword = String(search && typeof search === 'object' ? (search.value ?? '') : '').trim()
    const hasColumnSearch = columns.some(col => String(col.search?.value ?? '').trim() !== '')

    if (length !== -1 || globalKeyword !== '' || hasColumnSearch) {
      const filteredCountQuery = filteredQuery.clone()
      if (typeof filteredCountQuery.count === 'function') {
        filteredCountQuery.count({ count: '*' })
      }
      const filteredCountRes = await filteredCountQuery
      recordsFiltered = Number(filteredCountRes[0]?.count ?? 0)
    }

    // 4. Apply pagination limits
    if (length !== -1) {
      filteredQuery.offset(start).limit(length)
    }

    // 5. Retrieve data rows
    const rows = await filteredQuery

    // 6. Map and transform row structures
    const data = []
    for (let i = 0; i < rows.length; i++) {
      data.push(await this.transformRow(rows[i], columns, start + i + 1, true))
    }

    const payload = {
      draw,
      recordsTotal,
      recordsFiltered,
      data
    }

    if (response) {
      return response.json(payload)
    }

    return payload
  }

  // -------------------------------------------------------------------------
  // Export (CSV only, maps excel/pdf outputs to Excel-compatible CSV)
  // -------------------------------------------------------------------------

  async export(response: any, mapper: (row: any) => any[] | Promise<any[]>, fileName: string, type = 'csv'): Promise<any> {
    if (!this.exportHeaders) {
      throw new Error('Export headers are required. Call setExportHeaders() before export().')
    }

    const columns = this.resolveColumns()
    const query = this.query.clone()

    this.applyGlobalSearch(query, columns)
    this.applyColumnSearch(query, columns)
    this.applyOrdering(query, columns)

    const rows = await query

    const data: any[][] = []
    for (const row of rows) {
      const mapped = await mapper(row)
      if (!Array.isArray(mapped)) {
        throw new Error('Export mapper must return an array.')
      }
      data.push(mapped)
    }

    const sanitizedName = this.sanitizeFileName(fileName)
    const csvContent = this.generateCsv(this.exportHeaders, data)

    const { Readable } = await import('node:stream')
    return response.streamDownload(
      Readable.from([csvContent]),
      `${sanitizedName}.csv`,
      { 'content-type': 'text/csv; charset=utf-8' }
    )
  }

  // -------------------------------------------------------------------------
  // Helpers & Normalisation
  // -------------------------------------------------------------------------

  protected resolveColumns(): any[] {
    if (this.columnsList && this.columnsList.length > 0) {
      return this.columnsList
    }

    let inputCols = this.request.input<any>('columns', [])
    if (inputCols && typeof inputCols === 'object' && !Array.isArray(inputCols)) {
      inputCols = Object.keys(inputCols)
        .sort((a, b) => Number(a) - Number(b))
        .map(key => inputCols[key])
    }

    return this.normalizeColumns(inputCols)
  }

  protected normalizeColumns(columns: any[]): any[] {
    return columns
      .map(column => {
        if (typeof column === 'string') {
          return {
            data: column,
            name: column,
            searchable: true,
            orderable: true,
            search: { value: null }
          }
        }

        if (!column || typeof column !== 'object') {
          return null
        }

        const data = column.data
        const name = column.name ?? data

        if (!data) return null

        return {
          data: String(data),
          name: name ? String(name) : null,
          searchable: this.toBool(column.searchable ?? true),
          orderable: this.toBool(column.orderable ?? true),
          search: {
            value: column.search && typeof column.search === 'object' ? column.search.value : null
          }
        }
      })
      .filter(Boolean)
  }

  protected toBool(value: any): boolean {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1'
    }
    return Boolean(value)
  }

  protected applyGlobalSearch(query: any, columns: any[]): void {
    const search = this.request.input<any>('search')
    const keyword = String(search && typeof search === 'object' ? (search.value ?? '') : '').trim()

    if (keyword === '') {
      return
    }

    const searchable = columns.filter(col => {
      const dataKey = col.data
      const nameKey = col.name ?? dataKey
      
      // Prevent SQL errors by avoiding searching virtual columns that don't exist in DB
      if (dataKey in this.addedColumns && !this.filterCallbacks[dataKey]) {
        return false
      }
      
      return col.searchable && dataKey && nameKey && dataKey !== 'DT_RowIndex'
    })

    if (searchable.length === 0) {
      return
    }

    query.where((group: any) => {
      searchable.forEach(column => {
        const dataKey = column.data
        const nameKey = column.name ?? dataKey

        if (this.filterCallbacks[dataKey]) {
          this.filterCallbacks[dataKey](group, keyword, column, 'global')
        } else {
          this.applyAutomaticSearch(group, nameKey, keyword)
        }
      })
    })
  }

  protected applyColumnSearch(query: any, columns: any[]): void {
    columns.forEach(column => {
      const keyword = String(column.search?.value ?? '').trim()
      if (keyword === '') {
        return
      }

      const dataKey = column.data
      const nameKey = column.name ?? dataKey
      const searchable = column.searchable ?? true

      if (!searchable || !dataKey || !nameKey) {
        return
      }

      // Prevent SQL errors on virtual columns with no custom filter handler
      if (dataKey in this.addedColumns && !this.filterCallbacks[dataKey]) {
        return
      }

      if (this.filterCallbacks[dataKey]) {
        this.filterCallbacks[dataKey](query, keyword, column, 'column')
        return
      }

      if (nameKey.includes('.')) {
        const [relationPath, field] = this.splitRelationKey(nameKey)
        if (typeof query.whereHas === 'function') {
          query.whereHas(relationPath, (rel: any) => {
            rel.where(field, 'like', `%${keyword}%`)
          })
        } else {
          query.where(nameKey, 'like', `%${keyword}%`)
        }
      } else {
        query.where(nameKey, 'like', `%${keyword}%`)
      }
    })
  }

  protected applyAutomaticSearch(group: any, nameKey: string, keyword: string): void {
    if (nameKey.includes('.')) {
      const [relationPath, field] = this.splitRelationKey(nameKey)
      if (typeof group.orWhereHas === 'function') {
        group.orWhereHas(relationPath, (rel: any) => {
          rel.where(field, 'like', `%${keyword}%`)
        })
      } else {
        group.orWhere(nameKey, 'like', `%${keyword}%`)
      }
    } else {
      group.orWhere(nameKey, 'like', `%${keyword}%`)
    }
  }

  protected applyOrdering(query: any, columns: any[]): void {
    let orders = this.request.input<any>('order', [])
    if (orders && typeof orders === 'object' && !Array.isArray(orders)) {
      orders = Object.keys(orders)
        .sort((a, b) => Number(a) - Number(b))
        .map(key => orders[key])
    }

    if (!orders || orders.length === 0) {
      this.applyDefaultOrdering(query)
      return
    }

    let applied = false
    for (const order of orders) {
      const index = Number(order.column ?? -1)
      const direction = String(order.dir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc'
      const column = columns[index]

      if (!column) continue

      const dataKey = column.data
      const nameKey = column.name ?? dataKey
      const orderable = column.orderable ?? true

      if (!orderable || !dataKey || !nameKey || dataKey === 'DT_RowIndex') {
        continue
      }

      // Prevent SQL errors sorting virtual columns with no custom order callback
      if (dataKey in this.addedColumns && !this.orderCallbacks[dataKey]) {
        continue
      }

      if (this.orderCallbacks[dataKey]) {
        this.orderCallbacks[dataKey](query, direction, column)
        applied = true
        continue
      }

      if (!nameKey.includes('.')) {
        query.orderBy(nameKey, direction)
        applied = true
      }
    }

    if (!applied) {
      this.applyDefaultOrdering(query)
    }
  }

  protected applyDefaultOrdering(query: any): void {
    if (!this.defaultOrderColumn || this.defaultOrderColumn.includes('.')) {
      return
    }
    query.orderBy(this.defaultOrderColumn, this.defaultOrderDirection)
  }

  protected async transformRow(row: any, columns: any[], rowNumber: number, forRender = true): Promise<any> {
    const output: Record<string, any> = {}

    if (this.withIndexColumn) {
      output['DT_RowIndex'] = rowNumber
    }

    if (forRender && this.rowIdResolver !== null) {
      output['DT_RowId'] = await this.resolveRowId(row)
    }

    for (const column of columns) {
      const dataKey = column.data
      if (dataKey === 'DT_RowIndex') continue

      let value: any
      if (dataKey in this.addedColumns) {
        value = await this.addedColumns[dataKey](row, column)
      } else if (dataKey in this.multiEditedColumns) {
        const raw = this.resolveColumnValue(row, column)
        value = await this.multiEditedColumns[dataKey](raw)
      } else if (dataKey in this.editedColumns) {
        const raw = this.resolveColumnValue(row, column)
        value = await this.editedColumns[dataKey](row, raw, column)
      } else {
        value = this.resolveColumnValue(row, column)
      }

      if (forRender && this.shouldEscapeColumn(dataKey)) {
        value = this.escapeValue(value)
      }

      output[dataKey] = value
    }

    for (const dataKey of Object.keys(this.addedColumns)) {
      if (dataKey in output) continue

      let value = await this.addedColumns[dataKey](row, { data: dataKey, name: dataKey })

      if (forRender && this.shouldEscapeColumn(dataKey)) {
        value = this.escapeValue(value)
      }

      output[dataKey] = value
    }

    return output
  }

  protected resolveColumnValue(row: any, column: any): any {
    const dataKey = column.data
    const nameKey = column.name ?? dataKey

    if (nameKey && nameKey.includes('.')) {
      return this.dataGet(row, nameKey)
    }

    return dataKey ? this.dataGet(row, dataKey) : null
  }

  protected dataGet(target: any, key: string): any {
    if (!target) return null
    const parts = key.split('.')
    return parts.reduce((current, segment) => current?.[segment], target)
  }

  protected async resolveRowId(row: any): Promise<string> {
    if (typeof this.rowIdResolver === 'function') {
      return String(await this.rowIdResolver(row))
    }
    return String(this.dataGet(row, String(this.rowIdResolver)))
  }

  protected shouldEscapeColumn(dataKey: string): boolean {
    return this.escapeOutput && !this.rawColumnsList.includes(dataKey)
  }

  protected escapeValue(value: any): any {
    if (typeof value === 'string') {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
    }
    return value
  }

  protected splitRelationKey(nameKey: string): [string, string] {
    const parts = nameKey.split('.')
    const field = parts.pop()!
    return [parts.join('.'), field]
  }

  protected sanitizeFileName(fileName: string): string {
    const cleaned = fileName.trim()
    if (cleaned === '') return 'export'
    return cleaned
      .replace(/[^A-Za-z0-9\-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  protected escapeCsvValue(val: any): string {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  protected generateCsv(headers: string[], rows: any[][]): string {
    const bom = '\uFEFF'
    const headerLine = headers.map(h => this.escapeCsvValue(h)).join(',')
    const rowLines = rows.map(row => row.map(r => this.escapeCsvValue(r)).join(','))
    return bom + [headerLine, ...rowLines].join('\n')
  }
}

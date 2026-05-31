import * as XLSX from 'xlsx'
import { Readable } from 'node:stream'

export class ImExClass {
  /**
   * Download the export instance as a spreadsheet response.
   */
  async download(response: any, exportInstance: any, fileName: string, format?: 'csv' | 'xlsx' | 'xls'): Promise<any> {
    const type = format ?? this.detectFormat(fileName)
    const buffer = await this.generateExportBuffer(exportInstance, type)
    const sanitizedName = this.sanitizeFileName(fileName)

    const contentTypeMap = {
      csv: 'text/csv; charset=utf-8',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel'
    }

    const headers = {
      'content-type': contentTypeMap[type] || 'application/octet-stream'
    }

    return response.streamDownload(
      Readable.from([buffer]),
      sanitizedName,
      headers
    )
  }

  /**
   * Store the export instance on a filesystem disk.
   */
  async store(exportInstance: any, filePath: string, disk?: string, format?: 'csv' | 'xlsx' | 'xls'): Promise<void> {
    const type = format ?? this.detectFormat(filePath)
    const buffer = await this.generateExportBuffer(exportInstance, type)

    const { Storage } = await import('@lib/storage/Storage.js')
    await Storage.disk(disk).put(filePath, buffer)
  }

  /**
   * Import data using the import instance.
   */
  async import(importInstance: any, filePathOrBuffer: string | Buffer, disk?: string): Promise<void> {
    let buffer: Buffer

    if (typeof filePathOrBuffer === 'string') {
      const { Storage } = await import('@lib/storage/Storage.js')
      buffer = await Storage.disk(disk).get(filePathOrBuffer)
    } else {
      buffer = filePathOrBuffer
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const firstSheetName = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[firstSheetName]

    const useHeadingRow = typeof importInstance.headingRow === 'function'
    const headingRowIdx = useHeadingRow ? importInstance.headingRow() - 1 : 0

    const rawRows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 })
    
    let processedRows: any[] = []

    if (useHeadingRow) {
      const headings = rawRows[headingRowIdx] ?? []
      const dataRows = rawRows.slice(headingRowIdx + 1)

      processedRows = dataRows.map(row => {
        const obj: Record<string, any> = {}
        headings.forEach((heading, idx) => {
          if (heading !== undefined && heading !== null && row[idx] !== undefined) {
            obj[String(heading)] = row[idx]
          }
        })
        return obj
      })
    } else {
      processedRows = rawRows
    }

    if (typeof importInstance.collection === 'function') {
      await importInstance.collection(processedRows)
    } else if (typeof importInstance.model === 'function') {
      for (const row of processedRows) {
        const modelInstance = await importInstance.model(row)
        if (modelInstance && typeof modelInstance.save === 'function') {
          await modelInstance.save()
        }
      }
    }
  }

  private async generateExportBuffer(exportInstance: any, format: 'csv' | 'xlsx' | 'xls'): Promise<Buffer> {
    let rawData: any[] = []

    if (typeof exportInstance.query === 'function') {
      rawData = await exportInstance.query()
    } else if (typeof exportInstance.array === 'function') {
      rawData = await exportInstance.array()
    } else {
      throw new Error('Export instance must implement query() or array() method.')
    }

    let mappedData: any[][] = []

    // Map rows
    if (typeof exportInstance.map === 'function') {
      for (const row of rawData) {
        const mapped = await exportInstance.map(row)
        if (!Array.isArray(mapped)) {
          throw new Error('Export map() method must return an array.')
        }
        mappedData.push(mapped)
      }
    } else {
      mappedData = rawData.map(row => {
        if (Array.isArray(row)) return row
        if (typeof row === 'object' && row !== null) return Object.values(row)
        return [row]
      })
    }

    // Add headings
    if (typeof exportInstance.headings === 'function') {
      const headings = await exportInstance.headings()
      mappedData.unshift(headings)
    }

    // Generate sheet & workbook
    const worksheet = XLSX.utils.aoa_to_sheet(mappedData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')

    let bookType: XLSX.BookType = 'xlsx'
    if (format === 'csv') bookType = 'csv'
    else if (format === 'xls') bookType = 'biff8'

    const wopts: XLSX.WritingOptions = {
      bookType,
      type: 'buffer'
    }

    return XLSX.write(workbook, wopts)
  }

  private detectFormat(fileName: string): 'csv' | 'xlsx' | 'xls' {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext === 'csv') return 'csv'
    if (ext === 'xls') return 'xls'
    return 'xlsx'
  }

  private sanitizeFileName(fileName: string): string {
    const base = fileName.split(/[\\/]/).pop() || 'export'
    return base
  }
}

export const ImEx = new ImExClass()

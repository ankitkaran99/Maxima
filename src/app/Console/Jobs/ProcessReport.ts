export class ProcessReport {
  constructor(private report) {}
  async handle() {
    this.report.processed = true
  }
}

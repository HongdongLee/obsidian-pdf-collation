import { type App, FuzzySuggestModal, type TFile } from 'obsidian'

export class PdfSuggestModal extends FuzzySuggestModal<TFile> {
  private onChooseCallback: (file: TFile) => void

  constructor(app: App, onChooseCallback: (file: TFile) => void) {
    super(app)
    this.onChooseCallback = onChooseCallback
    this.setPlaceholder('输入关键字搜索库内的 PDF 文件进行绑定…')
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => f.extension.toLowerCase() === 'pdf')
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
  }

  getItemText(item: TFile): string {
    return item.path
  }

  onChooseItem(item: TFile): void {
    this.onChooseCallback(item)
  }
}

import { type App, FuzzySuggestModal, Notice, type TFile } from 'obsidian'

type PdfChoiceCallback = (file: TFile) => void | Promise<void>

export class PdfSuggestModal extends FuzzySuggestModal<TFile> {
  private onChooseCallback: PdfChoiceCallback

  constructor(app: App, onChooseCallback: PdfChoiceCallback) {
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
    void Promise.resolve()
      .then(() => this.onChooseCallback(item))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        new Notice(`绑定 PDF 失败：${message}`)
      })
  }
}

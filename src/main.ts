import { MarkdownView, Notice, Plugin, TFile } from 'obsidian'
import { upsertFrontmatterPdf } from './pairing'
import { PdfSuggestModal } from './pdf-suggest-modal'
import { CollationSettingTab } from './settings'
import { type CollationSettings, DEFAULT_SETTINGS } from './types'
import { CollationView, VIEW_TYPE_COLLATION } from './view'

export default class PdfCollationPlugin extends Plugin {
  settings: CollationSettings = { ...DEFAULT_SETTINGS }

  async onload(): Promise<void> {
    await this.loadSettings()

    this.registerView(VIEW_TYPE_COLLATION, (leaf) => new CollationView(leaf, this))

    this.addRibbonIcon('columns', '打开 PDF 双轨校勘视图', () => {
      void this.openCollationForActiveFile()
    })

    this.addCommand({
      id: 'open-pdf-collation',
      name: '打开当前笔记的双轨校勘视图 (Open PDF Collation)',
      callback: () => {
        void this.openCollationForActiveFile()
      },
    })

    this.addCommand({
      id: 'bind-pdf-to-note',
      name: '为当前笔记绑定配对 PDF 原件 (Bind PDF to Note)',
      callback: () => {
        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension.toLowerCase() !== 'md') {
          new Notice('请先打开一篇 Markdown 笔记')
          return
        }
        new PdfSuggestModal(this.app, async (chosenPdf) => {
          const key = this.settings.frontmatterKeys[0] || 'pdf'
          await this.app.vault.process(file, (raw) =>
            upsertFrontmatterPdf(raw, chosenPdf.path, key)
          )
          new Notice(`已绑定 ${chosenPdf.name} 到 ${file.name}`)
        }).open()
      },
    })

    this.addCommand({
      id: 'insert-sop-pagemark',
      name: '插入双页标 [p. X / pdf. Y]',
      editorCallback: (editor) => {
        const cursor = editor.getCursor()
        const snippet = '[p. 1 / pdf. 1]'
        editor.replaceSelection(snippet)
        editor.setCursor({ line: cursor.line, ch: cursor.ch + 4 })
      },
    })

    // 文件树右键菜单与编辑器右上角菜单直接打开双轨校勘
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('在双轨校勘视图中打开')
              .setIcon('columns')
              .onClick(() => {
                void this.openCollationForFile(file)
              })
          })
        }
      })
    )

    this.addSettingTab(new CollationSettingTab(this.app, this))
  }

  onunload(): void {
    // Obsidian 自动管理已注册视图的卸载
  }

  async openCollationForActiveFile(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(CollationView)
    if (activeView) return

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView)
    const file = mdView?.file ?? this.app.workspace.getActiveFile()
    if (!file || file.extension.toLowerCase() !== 'md') {
      new Notice('请先选中或打开一篇 Markdown 笔记')
      return
    }
    await this.openCollationForFile(file)
  }

  async openCollationForFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab')
    await leaf.setViewState({
      type: VIEW_TYPE_COLLATION,
      active: true,
      state: { file: file.path },
    })
    this.app.workspace.revealLeaf(leaf)
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<CollationSettings> | null
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}

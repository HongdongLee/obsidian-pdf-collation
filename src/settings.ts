import { type App, PluginSettingTab, Setting } from 'obsidian'
import type PdfCollationPlugin from './main'

export class CollationSettingTab extends PluginSettingTab {
  plugin: PdfCollationPlugin

  constructor(app: App, plugin: PdfCollationPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl).setName('配对与页标规则 (Pairing & Pagemarks)').setHeading()

    new Setting(containerEl)
      .setName('Frontmatter PDF 属性名')
      .setDesc('按优先级读取笔记 frontmatter 中指定的 PDF 链接字段，多个字段用英文逗号分隔。')
      .addText((text) =>
        text
          .setPlaceholder('pdf, source_pdf, annotation-target')
          .setValue(this.plugin.settings.frontmatterKeys.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.frontmatterKeys = value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('同名 PDF 自动搜索子目录')
      .setDesc('未在 frontmatter 指定 PDF 时，自动在当前目录及这些子目录中寻找同名 .pdf（用逗号分隔，留空项代表同级目录）。')
      .addText((text) =>
        text
          .setPlaceholder(', 原始PDF, PDF, pdfs, assets')
          .setValue(this.plugin.settings.pdfSubfolders.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.pdfSubfolders = value.split(',').map((s) => s.trim())
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('自定义页标正则表达式')
      .setDesc(
        '默认已兼容 [p. 33 / pdf. 35]、[pdf. 35]、<!-- page 35 -->、--- page 35 --- 及 [p. 33]。如需匹配特殊分页符，可填入带第一个捕获组 (\\d+) 的正则。'
      )
      .addText((text) =>
        text
          .setPlaceholder('例如：\\[页\\s*(\\d+)\\]')
          .setValue(this.plugin.settings.customPagemarkPattern)
          .onChange(async (value) => {
            this.plugin.settings.customPagemarkPattern = value.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('默认开启滚动联动')
      .setDesc('打开双轨校勘视图时，默认让 Markdown 栏跟随 PDF 滚动。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultFollowScroll)
          .onChange(async (value) => {
            this.plugin.settings.defaultFollowScroll = value
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('默认将 PDF 放在左侧')
      .setDesc('开启后默认左栏显示 PDF 原件，右栏显示 Markdown 校订稿。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultSwapped).onChange(async (value) => {
          this.plugin.settings.defaultSwapped = value
          await this.plugin.saveSettings()
        })
      )
  }
}
